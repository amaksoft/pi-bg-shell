import { existsSync, readFileSync, readdirSync, renameSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { readOwner, refreshOwnerLock } from "./owner-lock";
import { sessionJsonPath, sessionLockPath } from "./naming";
import { consumeCompletion } from "./jobs";
import { readByteSlice, readByteTail } from "./log-tail";
import { jobJsonPath, jobsDir } from "./naming";
import { atomicWriteJson, readJsonFile, type JobRecord, type SessionRecord } from "./sidecar";
import type { Session } from "./session";

/**
 * The single reconciler tick. The ONLY completion producer for an engine
 * spool dir — watcher hints, interval, and turn_start sweep all funnel into
 * tick(). Polls are best-effort snapshot views fanned out from the same tick;
 * completions are durable (journal-first consume). Delivery itself is an
 * injected callback (wired to follow-ups/toasts by the extension).
 */

export interface JobSnapshot {
  jobId: string;
  windowId: string;
  command: string;
  status: string;
  logFile: string;
  exitFile: string;
  startedAt: number;
  /** Owning spool dir (own or adopted): the tick is multi-dir. */
  spoolDir: string;
}

export interface CompletionItem {
  job: JobSnapshot;
  exitCode: number;
  logTail: string;
  /**
   * Latched (read/killed) before delivery: still consumed + cleaned up,
   * but no completion message fires. Set from the journal's notified flag.
   */
  suppressed?: boolean;
}

export interface ReconcilerCallbacks {
  /**
   * All jobs consumed in one tick, delivered as ONE batch (even singletons).
   * Batching at the tick means jobs finishing together report together —
   * one follow-up turn instead of N.
   */
  onCompletions: (items: CompletionItem[]) => void;
  /** Interim check-in with output appended since the last poll. */
  onPoll: (job: JobSnapshot, newText: string) => void;
  /**
   * Stall warning: log static past the threshold with an interactive-prompt
   * tail. Fires at most once per log size; never touches the notified latch
   * or consumes anything (the job is still running).
   */
  onStall?: (job: JobSnapshot, tail: string) => void;
  /**
   * Slow maintenance hook (GC trio: socket sweep, retention prune, reaper).
   * Fires at most every slowTickMs wall-clock, best-effort, never throws
   * into the tick. Lets a long-running session converge debris without
   * waiting for the next restart.
   */
  onSlowTick?: () => void;
}

export interface ReconcilerOptions {
  /** Ms between ticks. */
  tickMs: number;
  /** Minimum seconds between interim polls of the same job. */
  minimumPollIntervalSeconds: number;
  /** Max tail bytes per completion item. */
  completionTailBytes: number;
  /**
   * Backlog-aware coalescing window (ms). When a tick peeks completions
   * while OTHER jobs are still pending, delivery holds up to this long for
   * stragglers to join the batch. The last pending job always delivers
   * immediately (nothing to batch with); 0 (or absent) disables holding.
   */
  completionCoalesceMs?: number;
  /**
   * Ms of static log output before a prompt-tail triggers a stall warning.
   * 0 (or absent) disables stall detection.
   */
  stallPromptThresholdMs?: number;
  /**
   * Minimum ms between onSlowTick firings. 0 (or absent) disables.
   */
  slowTickMs?: number;
}

/** Owner-record refresh throttle (heartbeat file itself is touched every tick). */
export const OWNER_REFRESH_MS = 60000;

export const DEFAULT_RECONCILER_OPTIONS: ReconcilerOptions = {
  tickMs: 1000,
  minimumPollIntervalSeconds: 10,
  completionTailBytes: 8000,
  completionCoalesceMs: 2500,
  stallPromptThresholdMs: 120000,
};

interface PollCursor {
  lastPollAt: number;
  offset: number;
}

export class Reconciler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private cursors = new Map<string, PollCursor>();
  /** Log-growth tracking for stall detection: size, static-since, warned-at. */
  private stalls = new Map<string, { size: number; since: number; warnedAtSize: number }>();
  private stopped = false;
  private lastOwnerRefresh = 0;
  private lastSlowTick = 0;
  /**
   * Watched spool dirs: own + adopted. ONE tick covers all of them — no
   * per-dir reconciler objects to leak or double-fire. Per-dir maps below
   * are keyed `spoolDir/jobId` (6-hex ids can repeat across dirs).
   */
  private watched = new Map<string, { session: Session; ownerNonce?: string }>();
  /** Peeked-but-undelivered completions awaiting stragglers (never consumed yet). */
  private held: CompletionItem[] = [];
  /**
   * Consumed-but-undelivered completions (callback threw). Redelivered
   * from memory on later ticks — never re-consumed, never rolled back.
   * Keyed by job: bounded by live job count, latest wins.
   */
  private redeliver = new Map<string, CompletionItem>();
  private holdTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly session: Session,
    private readonly callbacks: ReconcilerCallbacks,
    private readonly options: ReconcilerOptions = DEFAULT_RECONCILER_OPTIONS,
    private readonly ownerNonce?: string,
  ) {
    this.watched.set(session.spoolDir, { session, ownerNonce });
  }

  /** Watch an adopted dir on the shared tick (no second reconciler). */
  watch(spoolDir: string, session: Session, ownerNonce?: string): void {
    this.watched.set(spoolDir, { session, ownerNonce });
  }

  /**
   * Stop watching a dir; drop its cursor/stall/held state. Queued
   * redeliveries get one final best-effort send first: their rows are
   * consumed, and nobody else will deliver them.
   */
  unwatch(spoolDir: string): void {
    this.watched.delete(spoolDir);
    const prefix = `${spoolDir}/`;
    for (const map of [this.cursors, this.stalls] as const) {
      for (const key of [...map.keys()]) if (key.startsWith(prefix)) map.delete(key);
    }
    this.held = this.held.filter((item) => item.job.spoolDir !== spoolDir);
    const farewell: CompletionItem[] = [];
    for (const [key, item] of [...this.redeliver]) {
      if (key.startsWith(prefix)) {
        farewell.push(item);
        this.redeliver.delete(key);
      }
    }
    if (farewell.length > 0) {
      try {
        this.callbacks.onCompletions(farewell);
      } catch {
        // Shutdown-equivalent: drop rather than strand; journals are terminal.
      }
    }
  }

  /** Dir-scoped map key (jobIds repeat across dirs). */
  private static key(spoolDir: string, jobId: string): string {
    return `${spoolDir}/${jobId}`;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch {
        // A tick must never throw: backstops stay silent on error.
      }
    }, this.options.tickMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    // Best-effort: deliver stragglers rather than stranding them held.
    try {
      this.flushHeld();
    } catch {
      // Shutdown delivery may already be gone; held rows were never
      // consumed, so a later session recovers them.
    }
    try {
      this.flushRedeliver();
    } catch {
      // Gone with the process; journals are terminally consumed.
    }
  }

  /**
   * Manual kick: turn_start sweep and watcher hints call this (same path).
   * Ticks, then flushes immediately — a user interacting gets answers now,
   * not after the coalescing window.
   */
  kick(): void {
    try {
      this.tick();
    } catch {
      // Fail silent like the interval path.
    }
    try {
      this.flushHeld();
    } catch {
      // Fail silent like the interval path.
    }
  }

  private coalesceMs(): number {
    return this.options.completionCoalesceMs ?? DEFAULT_RECONCILER_OPTIONS.completionCoalesceMs ?? 0;
  }

/**
 * Owner heartbeat (S4.1) for every watched dir: touch the heartbeat file
 * every pass (cheap mtime-only liveness signal) and refresh
 * held owner records at most once a minute. Skips silently on nonce
 * mismatch — never fights another owner.
 */
  private heartbeatTick(): void {
    for (const [spoolDir, entry] of this.watched) {
      // Takeover loss: the dir's epoch moved without us (adopted or
      // reclaimed elsewhere). Stop watching instead of double-driving it —
      // the new owner's tick owns delivery now. Silent by tick contract.
      try {
        const live = readJsonFile<SessionRecord>(sessionJsonPath(spoolDir));
        if (live && (live.epoch ?? 0) !== (entry.session.epoch ?? 0)) {
          this.unwatch(spoolDir);
          continue;
        }
      } catch {
        // Unreadable sidecar: cannot prove movement, keep watching.
      }
      try {
        // The gating file: heartbeatAgeMs reads session.lock/heartbeat, so
        // the cheap per-tick touch must land there (not spool/heartbeat).
        utimesSync(join(sessionLockPath(spoolDir), "heartbeat"), new Date(), new Date());
      } catch {
        continue;
      }
      const now = Date.now();
      if (!entry.ownerNonce || now - this.lastOwnerRefresh < OWNER_REFRESH_MS) continue;
      try {
        const owner = readOwner(sessionLockPath(spoolDir));
        if (owner && owner.nonce === entry.ownerNonce) {
          refreshOwnerLock(sessionLockPath(spoolDir), entry.ownerNonce);
        }
      } catch {
        // Best-effort; the file touch above is the signal.
      }
    }
    this.lastOwnerRefresh = Date.now();
  }

  /** The one and only completion/poll pass over all watched spool dirs. */
  tick(): void {
    if (this.stopped) return;
    this.heartbeatTick();
    this.maybeSlowTick();
    this.flushRedeliver();
    const heldIds = new Set(
      this.held.map((item) => Reconciler.key(item.job.spoolDir, item.job.jobId)),
    );
    const peeked: CompletionItem[] = [];
    let pendingOthers = 0;
    for (const [spoolDir] of this.watched) {
      let files: string[];
      try {
        files = readdirSync(jobsDir(spoolDir));
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const jobId = file.slice(0, -".json".length);
        const outcome = this.tickJob(spoolDir, jobId, heldIds);
        if (outcome.kind === "peeked") peeked.push(outcome.item);
        else if (outcome.kind === "pending") pendingOthers += 1;
      }
    }
    if (peeked.length === 0) return;
    // Backlog-aware coalescing: peers still running mean stragglers are
    // likely — hold briefly so they join one batch. Last job (or
    // coalescing off) delivers immediately.
    if (pendingOthers > 0 && this.coalesceMs() > 0) {
      this.hold(peeked);
      return;
    }
    this.flush(peeked);
  }

  /** Hold peeked items for stragglers; replaces any pending hold window. */
  private hold(items: CompletionItem[]): void {
    const known = new Set(this.held.map((item) => Reconciler.key(item.job.spoolDir, item.job.jobId)));
    for (const item of items) {
      const key = Reconciler.key(item.job.spoolDir, item.job.jobId);
      if (!known.has(key)) {
        known.add(key);
        this.held.push(item);
      }
    }
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = setTimeout(() => {
      this.holdTimer = undefined;
      try {
        this.flushHeld();
      } catch {
        // Delivery must never break the tick loop.
      }
    }, this.coalesceMs());
    if (typeof this.holdTimer.unref === "function") this.holdTimer.unref();
  }

  /** Flush held items now (kick, stop, or window elapsed). */
  private flushHeld(): void {
    if (this.holdTimer) {
      clearTimeout(this.holdTimer);
      this.holdTimer = undefined;
    }
    if (this.held.length === 0) return;
    const items = this.held;
    this.held = [];
    this.flush(items);
  }

  /**
   * Consume + deliver a batch. Nothing is consumed while held, so crash
   * recovery is trivial: unconsumed exit files are simply re-peeked by the
   * next session. Claims are re-checked at flush (a foreground waiter may
   * have arrived since the peek) — skipped rows stay pending.
   */
  /**
   * Consume ready completions for one dir (shared by the tick flush and the
   * adopt one-shot): claim re-checks at consume time, exactly-once rename,
   * journal-latched rows flagged suppressed. Pure journal work, no delivery.
   */
  consumeReady(session: Session, jobIds: string[]): CompletionItem[] {
    const ready: CompletionItem[] = [];
    // Epoch gate at consume time (not just tick start): a takeover that
    // lands mid-tick must not consume under the old generation. Absent
    // sidecar proceeds (fake/test dirs carry no session.json); a present
    // sidecar with a moved epoch refuses.
    let live: SessionRecord | undefined;
    try {
      live = readJsonFile<SessionRecord>(sessionJsonPath(session.spoolDir));
    } catch {
      live = undefined;
    }
    if (live && (live.epoch ?? 0) !== (session.epoch ?? 0)) return [];
    const stealAfterMs = claimStealAfterMs(this.options.minimumPollIntervalSeconds);
    for (const jobId of jobIds) {
      const record = readJsonFile<JobRecord>(jobJsonPath(session.spoolDir, jobId));
      if (!record || record.status !== "running") continue;
      if (record.foregroundClaim && !isClaimStale(record, stealAfterMs)) continue;
      if (record.foregroundClaim && isClaimStale(record, stealAfterMs)) {
        record.foregroundClaim = false;
        atomicWriteJson(jobJsonPath(session.spoolDir, jobId), record);
      }
      const completion = consumeCompletion(session, jobId);
      if (!completion) continue;
      // Latched (read/killed) before delivery: still consumed + cleaned up,
      // but the completion message must not fire for already-seen outcomes.
      // Re-read AFTER the consume: a latch landing between the two reads
      // must suppress, never deliver.
      const fresh = readJsonFile<JobRecord>(jobJsonPath(session.spoolDir, jobId));
      const suppressed = fresh?.seen === true;
      const key = Reconciler.key(session.spoolDir, jobId);
      this.cursors.delete(key);
      this.stalls.delete(key);
      ready.push({
        job: toSnapshot(session.spoolDir, record),
        exitCode: completion.exitCode,
        logTail: readByteTail(completion.logFile, this.options.completionTailBytes),
        ...(suppressed ? { suppressed: true as const } : {}),
      });
    }
    return ready;
  }

  private flush(items: CompletionItem[]): void {
    const delivered: CompletionItem[] = [];
    for (const item of items) {
      const entry = this.watched.get(item.job.spoolDir);
      if (!entry) continue; // unwatched since peek (released dir): drop it
      delivered.push(...this.consumeReady(entry.session, [item.job.jobId]));
    }
    if (delivered.length > 0) {
      try {
        this.callbacks.onCompletions(delivered);
      } catch {
        // No journal rollback: consumed rows stay consumed (crash-safe as
        // written). Queue for redelivery instead of silently dropping;
        // flushRedeliver refreshes suppression per item at send time.
        this.queueRedeliver(delivered);
      }
    }
  }

  /** Maximum queued redeliveries (sendMessage down for long stretches). */
  private static readonly MAX_REDELIVER = 200;

  /** Queue for redelivery, bounded (oldest dropped past the cap). */
  private queueRedeliver(items: CompletionItem[]): void {
    for (const item of items) {
      const key = Reconciler.key(item.job.spoolDir, item.job.jobId);
      if (!this.redeliver.has(key) && this.redeliver.size >= Reconciler.MAX_REDELIVER) {
        const oldest = this.redeliver.keys().next();
        if (!oldest.done) this.redeliver.delete(oldest.value);
      }
      this.redeliver.set(key, item);
    }
  }

  /**
   * Best-effort redelivery of items whose delivery threw. Refreshes the
   * suppressed flag per item (a latch landing between flush and redelivery
   * must suppress the re-ping) and skips dirs that lost watch since.
   * Idempotent.
   */
  /**
   * Slow maintenance hook (see onSlowTick): wall-clock gated, best-effort,
   * never throws into the tick. Stamped before firing so a throwing hook
   * still waits a full window before retrying.
   */
  private maybeSlowTick(): void {
    const everyMs = this.options.slowTickMs ?? 0;
    if (!everyMs || !this.callbacks.onSlowTick) return;
    const now = Date.now();
    if (now - this.lastSlowTick < everyMs) return;
    this.lastSlowTick = now;
    try {
      this.callbacks.onSlowTick();
    } catch {
      // Best-effort GC must never break the tick.
    }
  }

  private flushRedeliver(): void {
    if (this.redeliver.size === 0) return;
    const live: CompletionItem[] = [];
    for (const [key, item] of [...this.redeliver]) {
      const spoolDir = key.slice(0, key.lastIndexOf("/"));
      if (!this.watched.has(spoolDir)) {
        this.redeliver.delete(key);
        continue;
      }
      try {
        const fresh = readJsonFile<JobRecord>(jobJsonPath(spoolDir, item.job.jobId));
        if (fresh?.seen === true) item.suppressed = true;
      } catch {
        // Keep the flush-time flag on unreadable journals.
      }
      live.push(item);
    }
    if (live.length === 0) return;
    try {
      this.callbacks.onCompletions(live);
    } catch {
      return; // stay queued; a later tick (or shutdown) retries
    }
    for (const item of live) {
      this.redeliver.delete(Reconciler.key(item.job.spoolDir, item.job.jobId));
    }
  }

  /**
   * One tick-job. Peek-only: a finished row returns its item WITHOUT
   * consuming (consumption happens at flush), so held-then-crashed jobs
   * lose nothing. Polls still emit inline.
   */
  private tickJob(
    spoolDir: string,
    jobId: string,
    heldIds: Set<string>,
  ): { kind: "peeked"; item: CompletionItem } | { kind: "pending" } | { kind: "skip" } {
    const key = Reconciler.key(spoolDir, jobId);
    const record = readJsonFile<JobRecord>(jobJsonPath(spoolDir, jobId));
    if (!record) {
      this.cursors.delete(key);
      this.stalls.delete(key);
      return { kind: "skip" };
    }
    if (record.status !== "running") {
      this.cursors.delete(key);
      this.stalls.delete(key);
      return { kind: "skip" };
    }
    // Already held awaiting flush: done logically, not a peer, not re-peeked.
    if (heldIds.has(key)) return { kind: "skip" };
    // Phantom: journal-first spawn crashed before the window existed (empty
    // windowId, exit file can never appear). Finalize silently as killed —
    // it never ran, so there is nothing to deliver and nothing to adopt.
    if (!record.windowId) {
      record.status = "killed";
      atomicWriteJson(jobJsonPath(spoolDir, jobId), record);
      this.cursors.delete(key);
      this.stalls.delete(key);
      return { kind: "skip" };
    }
    // S6 (local-only): a live foreground waiter owns the row; the tick skips
    // it. (Still counts as pending below: someone owns its completion.)
    const stealAfterMs = claimStealAfterMs(this.options.minimumPollIntervalSeconds);
    if (record.foregroundClaim && !isClaimStale(record, stealAfterMs)) return { kind: "pending" };
    const snapshot = toSnapshot(spoolDir, record);
    // Finished? Peek (read + strict parse, no rename). Torn writes defer.
    if (existsSync(record.exitFile) || existsSync(`${record.exitFile}.consumed`)) {
      const code = peekExitCode(record.exitFile);
      if (code !== undefined) {
        this.cursors.delete(key);
        this.stalls.delete(key);
        return {
          kind: "peeked",
          item: {
            job: snapshot,
            exitCode: code,
            logTail: readByteTail(record.spoolLog, this.options.completionTailBytes),
          },
        };
      }
      return { kind: "pending" };
    }
    // Still running: stall check (prompt-tail on a static log) runs before
    // the interim poll path; neither consumes nor latches anything.
    this.checkStall(record, snapshot);
    // Interim poll path (best-effort): due check + new-bytes slice.
    const now = Date.now();
    const cursor = this.cursors.get(key) ?? { lastPollAt: 0, offset: 0 };
    if (now - cursor.lastPollAt < this.options.minimumPollIntervalSeconds * 1000)
      return { kind: "pending" };
    const size = fileSize(record.spoolLog);
    if (size === null || size <= cursor.offset) {
      this.cursors.set(key, { lastPollAt: now, offset: size ?? cursor.offset });
      return { kind: "pending" };
    }
    const newText = readByteSlice(record.spoolLog, cursor.offset, size);
    this.cursors.set(key, { lastPollAt: now, offset: size });
    if (newText.trim().length > 0) this.callbacks.onPoll(snapshot, newText);
    return { kind: "pending" };
  }

  /**
   * Stall check for one running job: static log past the threshold with an
   * interactive-prompt tail fires onStall once per log size. Never consumes,
   * never latches, never touches the journal — the job is still running.
   * (Prompt set mirrors patty-bg-tasks; the tick integration is ours.)
   */
  private checkStall(record: JobRecord, snapshot: JobSnapshot): void {
    const threshold =
      this.options.stallPromptThresholdMs ?? DEFAULT_RECONCILER_OPTIONS.stallPromptThresholdMs ?? 0;
    if (!threshold || !this.callbacks.onStall) return;
    const size = fileSize(record.spoolLog);
    if (size === null) return;
    const now = Date.now();
    const stallKey = Reconciler.key(snapshot.spoolDir, record.jobId);
    const tracked = this.stalls.get(stallKey);
    if (!tracked || tracked.size !== size) {
      this.stalls.set(stallKey, {
        size,
        since: now,
        warnedAtSize: tracked?.warnedAtSize ?? -1,
      });
      return;
    }
    if (now - tracked.since < threshold || tracked.warnedAtSize === size) return;
    tracked.warnedAtSize = size;
    const tail = readByteTail(record.spoolLog, STALL_TAIL_BYTES);
    if (!looksLikePrompt(tail)) return;
    try {
      this.callbacks.onStall(snapshot, tail);
    } catch {
      // Best-effort; the warning must never break the tick.
    }
  }
}

/** Tail bytes scanned for interactive-prompt stall verdicts. */
const STALL_TAIL_BYTES = 2048;

/** Last-line patterns identifying an interactive prompt. */
const STALL_PROMPT_PATTERNS = [
  /\(y\/n\)/i,
  /\[y\/n\]/i,
  /\(yes\/no\)/i,
  /\b(?:Do you|Would you|Shall I|Are you sure|Ready to)\b.*\? *$/i,
  /Press (any key|Enter)/i,
  /Continue\?/i,
  /Overwrite\?/i,
];

const looksLikePrompt = (tail: string): boolean => {
  const lastLine = tail.trimEnd().split("\n").pop() ?? "";
  return STALL_PROMPT_PATTERNS.some((pattern) => pattern.test(lastLine));
};

/** Strict exit-code peek with zero side effects (no rename, no journal). */
const peekExitCode = (exitFile: string): number | undefined => {
  const source = existsSync(exitFile) ? exitFile : existsSync(`${exitFile}.consumed`) ? `${exitFile}.consumed` : undefined;
  if (!source) return undefined;
  let raw: string;
  try {
    raw = readFileSync(source, "utf8");
  } catch {
    return undefined;
  }
  const code = Number(raw.trim().split("\n", 1)[0]);
  return Number.isInteger(code) ? code : undefined;
};

const isClaimStale = (record: JobRecord, stealAfterMs: number): boolean => {
  if (!record.claimHeartbeatAt) return true;
  const at = Date.parse(record.claimHeartbeatAt);
  if (!Number.isFinite(at)) return true;
  return Date.now() - at > stealAfterMs;
};

export const claimStealAfterMs = (minimumPollIntervalSeconds: number): number =>
  Math.max(30000, minimumPollIntervalSeconds * 3000 + 15000);

const toSnapshot = (spoolDir: string, record: JobRecord): JobSnapshot => ({
  jobId: record.jobId,
  windowId: record.windowId,
  startedAt: record.startedAt ?? Date.now(),
  command: record.command ?? "",
  status: record.status,
  logFile: record.spoolLog,
  exitFile: record.exitFile,
  spoolDir,
});

const fileSize = (path: string): number | null => {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
};
