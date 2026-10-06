import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatEnvironmentExportsForBash, shellQuote } from "../tmux-utils";
import { jobJsonPath, jobsDir, sessionJsonPath, sessionLockPath } from "./naming";
import { isOwnerDead, readOwner } from "./owner-lock";
import type { Runner, Session } from "./session";
import { GUID_OPTION } from "./session";

/** Per-window job tag, read back to translate live @ids to jobIds. */
export const JOB_ID_OPTION = "@pi_job_id";
import { atomicWriteJson, ensureDir, readJsonFile, type JobRecord, type SessionRecord } from "./sidecar";

/**
 * The engine execution path. Window protocol: EXIT-trap writes the exit
 * code, output tees to the spool log; exit file
 * <spoolDir>/jobs/<jobId>.exit, log <jobId>.exit.out.
 */

export const JOB_ID_RE = /^[0-9a-f]{6}$/;

export const mintJobId = (taken?: (id: string) => boolean): string => {
  let id = randomBytes(3).toString("hex");
  while (taken?.(id)) id = randomBytes(3).toString("hex");
  return id;
};

export interface SpawnParams {
  session: Session;
  runner: Runner;
  tmuxBinary: string;
  command: string;
  name?: string;
  cwd: string;
  envDenylist: readonly string[];
  windowName: string;
}

const buildCommandScript = (params: {
  spoolDir: string;
  jobId: string;
  command: string;
  displayCommand: string;
  cwd: string;
  envDenylist: readonly string[];
}): { scriptPath: string; exitFile: string; logFile: string } => {
  const { spoolDir, jobId, command, displayCommand, cwd, envDenylist } = params;
  const scriptDir = join(spoolDir, "s");
  mkdirSync(scriptDir, { recursive: true, mode: 0o700 });
  chmodSync(scriptDir, 0o700);
  const exitFile = join(jobsDir(spoolDir), `${jobId}.exit`);
  const logFile = `${exitFile}.out`;
  const scriptPath = join(scriptDir, `${jobId}.sh`);
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env bash
__exit_code_file=${shellQuote(exitFile)}
__output_file=${shellQuote(logFile)}
# Same backstop as legacy: syntax death still fires EXIT with $? set.
trap '__rc=$?; [ -e "$__exit_code_file" ] || printf "%s\\n" "$__rc" > "$__exit_code_file"' EXIT
: > "$__output_file"
printf '$ %s\n' ${shellQuote(displayCommand)}
${formatEnvironmentExportsForBash(process.env, envDenylist)}
cd ${shellQuote(cwd)} || { printf 'bg-shell: cannot cd to launch directory\n' >&2; exit 97; }
(
${command}
) 2>&1 | tee -a "$__output_file"
__rc=\${PIPESTATUS[0]}
printf '%s\n' "$__rc" > "$__exit_code_file"
if [ -n "\${SHELL:-}" ] && [ -x "\${SHELL:-}" ]; then
  exec "$SHELL" -l
fi
exec bash -l
`,
    { mode: 0o700 },
  );
  return { scriptPath, exitFile, logFile };
};

/**
 * Spawn one command in its own window on the private server; journal the job
 * record BEFORE the window starts (journal-first, S2).
 */
export const spawnJob = (
  params: SpawnParams,
  taken?: (id: string) => boolean,
): { jobId: string; windowId: string; exitFile: string; logFile: string } => {
  const { session, runner } = params;
  const jobId = mintJobId(taken);
  ensureDir(jobsDir(session.spoolDir));
  const { scriptPath, exitFile, logFile } = buildCommandScript({
    spoolDir: session.spoolDir,
    jobId,
    command: params.command,
    displayCommand: params.command.split("\n")[0].slice(0, 200),
    cwd: params.cwd,
    envDenylist: params.envDenylist,
  });
  const record: JobRecord = {
    jobId,
    windowId: "",
    startedAt: Date.now(),
    name: params.name,
    command: params.command,
    windowName: params.windowName,
    spoolLog: logFile,
    exitFile,
    foregroundClaim: false,
    status: "running",
    seen: false,
  };
  atomicWriteJson(jobJsonPath(session.spoolDir, jobId), record);
  const windowId = runner
    .tmux(session.socketName, [
      "new-window",
      "-d",
      "-t",
      session.sessionName,
      "-n",
      params.windowName,
      "-c",
      params.cwd,
      "-P",
      "-F",
      "#{window_id}",
      scriptPath,
    ])
    .trim();
  runner.tmux(session.socketName, ["set-option", "-t", windowId, JOB_ID_OPTION, jobId]);
  record.windowId = windowId;
  atomicWriteJson(jobJsonPath(session.spoolDir, jobId), record);
  return { jobId, windowId, exitFile, logFile };
};

/**
 * Set the notified latch: the outcome was surfaced (read/killed), so the
 * pending completion ping must not fire. Journal-durable, idempotent,
 * best-effort (a missing journal simply has nothing to suppress).
 */
export const markJobNotified = (session: Session, jobId: string): void => {
  try {
    const record = readJsonFile<JobRecord>(jobJsonPath(session.spoolDir, jobId));
    if (!record || record.seen) return;
    record.seen = true;
    atomicWriteJson(jobJsonPath(session.spoolDir, jobId), record);
  } catch {
    // Best-effort; delivery re-checks the latch anyway.
  }
};

export type WaitResult =
  | { status: "completed"; exitCode: number }
  | { status: "timeout" }
  | { status: "aborted" }
  | { status: "detached" };

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const readExitFile = (exitFile: string): number | undefined => {
  let raw: string;
  try {
    raw = readFileSync(exitFile, "utf8");
  } catch {
    return undefined;
  }
  const code = Number(raw.trim().split("\n", 1)[0]);
  return Number.isInteger(code) ? code : undefined;
};

/** Blocking wait on the exit file (foreground waiter; S6 claim is managed by the caller via journal). */
export const waitJob = async (
  exitFile: string,
  opts: { timeoutMs: number; signal?: AbortSignal; pollMs?: number; onDetach?: () => boolean },
): Promise<WaitResult> => {
  const deadline = Date.now() + opts.timeoutMs;
  const pollMs = opts.pollMs ?? 250;
  for (;;) {
    if (opts.signal?.aborted) return { status: "aborted" };
    if (opts.onDetach?.()) return { status: "detached" };
    const code = readExitFile(exitFile);
    if (code !== undefined) return { status: "completed", exitCode: code };
    if (Date.now() >= deadline) return { status: "timeout" };
    await sleepMs(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
};

/**
 * Peek: bounded live pane snapshot in the legacy text shape
 * (tmux window: <name> <id>\n$ <cmd>\n<output>).
 */
export const peekJob = (
  session: Session,
  runner: Runner,
  job: { jobId: string; windowId: string; command: string; windowName: string },
  contextLines: number,
): string => {
  let lines = "";
  try {
    lines = runner.tmux(session.socketName, [
      "capture-pane",
      "-p",
      "-t",
      `${session.sessionName}:${job.windowId}`,
      "-S",
      `-${contextLines}`,
    ]);
  } catch {
    lines = "";
  }
  const body = lines.trim().length > 0 ? lines.trimEnd() : "(no output)";
  return `tmux window: ${job.windowName} ${job.windowId}\n$ ${job.command}\n${body}`;
};

export type KillResult = "killed" | "already-gone" | "refused";

/**
 * S3 guarded kill: GUID predicate + kill in ONE server round-trip via
 * if-shell (formats expand against the target before sh sees them), so a
 * recycled window id cannot slip between a separate verify and kill.
 * A dead target reads as already-gone (idempotent).
 */
/**
 * The single guarded kill path. Fencing order: epoch (dir moved under us)
 * → lock self-check (live foreign owner) → journal txn (killed + latched)
 * → client GUID pre-check (observability) → one fenced if-shell kill.
 * Every check fails closed to "refused" except unreadable state, where the
 * server-side GUID predicate remains the backstop (fail open, still safe).
 */
export const killGuarded = (
  session: Session,
  runner: Runner,
  job: { jobId: string; windowId: string },
  staleAfterMs: number,
): KillResult => {
  // Epoch fence: the dir was taken over since this Session object was made.
  try {
    const current = readJsonFile<SessionRecord>(sessionJsonPath(session.spoolDir));
    if (current && (current.epoch ?? 0) !== (session.epoch ?? 0)) return "refused";
  } catch {
    // Unreadable sidecar: GUID predicate below still guards the kill.
  }
  // Lock self-check: proceed when we hold the lock (nonce match), when no
  // lock exists (tests, pre-fencing setup), or when the holder is dead.
  // A live foreign owner means takeover loss: refuse instead of double-kill.
  try {
    const lockDir = sessionLockPath(session.spoolDir);
    const holder = readOwner(lockDir);
    if (
      holder &&
      holder.nonce !== session.ownerNonce &&
      !isOwnerDead(lockDir, holder, staleAfterMs)
    ) {
      return "refused";
    }
  } catch {
    // Unreadable lock: GUID predicate below still guards the kill.
  }
  const windowId = job.windowId;
  // Shell-string safety: session/window/socket flow into an if-shell
  // predicate parsed by sh. Canonical names always match; anything else
  // (hostile pi-id, tampered journal) refuses instead of interpolating.
  const safeTarget = (value: string): boolean => /^[A-Za-z0-9_.:@/-]+$/.test(value);
  if (!safeTarget(session.socketName) || !safeTarget(session.sessionName) || !safeTarget(windowId)) {
    return "refused";
  }
  // Client-side GUID pre-check, BEFORE the txn: a refusal must leave the
  // journal pristine (else the live window leaks: not pending, still
  // running, nobody watching). Observability only — the if-shell predicate
  // below is the real fence against recycled windows. Unreadable → proceed.
  try {
    const liveGuid = runner
      .tmux(session.socketName, [
        "display-message",
        "-p",
        "-t",
        session.sessionName,
        `#{${GUID_OPTION}}`,
      ])
      .trim();
    if (liveGuid && liveGuid !== session.sessionGuid) return "refused";
  } catch {
    // Gone or unreadable: the kill below reports already-gone itself.
  }
  // Journal-first suppression + latch BEFORE the tmux kill, so a late
  // EXIT-trap write finds completionPending=false and stays silent by
  // construction — no ordering race, single writer. Caller-side latches
  // are subsumed here (a refused kill latches nothing: the death, if any,
  // was not deliberate).
  const record = readJsonFile<JobRecord>(jobJsonPath(session.spoolDir, job.jobId));
  const wasSeen = record?.seen === true;
  if (record && record.status === "running") {
    record.status = "killed";
    record.seen = true;
    atomicWriteJson(jobJsonPath(session.spoolDir, job.jobId), record);
    // Re-read epoch AFTER the write: a takeover interleaved with the txn
    // wrote killed into the new owner's dir. Restore to running (the most
    // recoverable state — their tick re-evaluates) and abort the kill.
    // GUID would save the window, not the journal.
    try {
      const moved = readJsonFile<SessionRecord>(sessionJsonPath(session.spoolDir));
      if (moved && (moved.epoch ?? 0) !== (session.epoch ?? 0)) {
        try {
          const poisoned = readJsonFile<JobRecord>(jobJsonPath(session.spoolDir, job.jobId));
          if (poisoned && poisoned.status === "killed") {
            poisoned.status = "running";
            poisoned.seen = wasSeen;
            atomicWriteJson(jobJsonPath(session.spoolDir, job.jobId), poisoned);
          }
        } catch {
          // Best-effort restore.
        }
        return "refused";
      }
    } catch {
      // Unreadable sidecar: proceed, GUID predicate still guards the kill.
    }
  }
  try {
    runner.tmux(session.socketName, [
      "if-shell",
      "-t",
      `${session.sessionName}:${windowId}`,
      `[ "#{session_name}:#{${GUID_OPTION}}" = "${session.sessionName}:${session.sessionGuid}" ]`,
      `kill-window -t ${session.sessionName}:${windowId}`,
    ]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (/can't find (window|session)|unknown session|no such/i.test(detail)) return "already-gone";
    // Unexpected tmux failure: fall through to end-state verification
    // below instead of assuming either outcome.
  }
  // if-shell exits 0 whether or not the GUID predicate matched, so a
  // return code proves nothing. Verify the end state: window gone means
  // the kill landed (or the target was already dead); window alive means
  // the predicate missed or the kill failed — roll the txn back and
  // refuse. Unverifiable means fail closed the same way.
  let alive = true;
  try {
    alive = windowAlive(session, runner, windowId);
  } catch {
    alive = true;
  }
  if (!alive) return "killed";
  try {
    const live = readJsonFile<JobRecord>(jobJsonPath(session.spoolDir, job.jobId));
    if (live && live.status === "killed") {
      live.status = "running";
      live.seen = wasSeen;
      atomicWriteJson(jobJsonPath(session.spoolDir, job.jobId), live);
    }
  } catch {
    // Best-effort restore; the GUID predicate still guards retries.
  }
  return "refused";
};

/**
 * Window liveness with tri-state honesty. tmux resolves a dead
 * `session:window` target to the ACTIVE window instead of erroring, so
 * mere non-emptiness proves nothing: alive requires echoing OUR id back.
 * true = proven alive, false = proven gone (id mismatch or target-syntax
 * miss), throw = unverifiable. Callers fail closed on throw — unknown
 * liveness must never strand a terminal journal on a running job.
 */
const windowAlive = (session: Session, runner: Runner, windowId: string): boolean => {
  try {
    const out = runner.tmux(session.socketName, [
      "display-message",
      "-p",
      "-t",
      `${session.sessionName}:${windowId}`,
      "#{window_id}",
    ]);
    return out.trim() === windowId;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (/can't find (window|session)|unknown session|no such/i.test(detail)) return false;
    throw error;
  }
};

export interface Completion {
  exitCode: number;
  logFile: string;
}

/**
 * Exactly-once consume: atomic rename first, strict parse second, journal
 * delivered-local last. A torn write defers (stays pending-local); a crash
 * between rename and journal re-reports from the .consumed file on rebuild.
 */
export const consumeCompletion = (
  session: Session,
  jobId: string,
): Completion | undefined => {
  const record = readJsonFile<JobRecord>(jobJsonPath(session.spoolDir, jobId));
  if (!record || record.status !== "running") return undefined;
  const consumed = `${record.exitFile}.consumed`;
  const source = existsSync(record.exitFile) ? record.exitFile : existsSync(consumed) ? consumed : undefined;
  if (!source) return undefined;
  let raw: string;
  try {
    raw = readFileSync(source, "utf8");
  } catch {
    return undefined;
  }
  const code = Number(raw.trim().split("\n", 1)[0]);
  if (!Number.isInteger(code)) return undefined; // torn write: defer, stay pending
  try {
    if (source === record.exitFile) renameSync(record.exitFile, consumed);
  } catch {
    return undefined; // lost the race (another consumer): not ours
  }
  record.status = "completed";
  atomicWriteJson(jobJsonPath(session.spoolDir, jobId), record);
  return { exitCode: code, logFile: record.spoolLog };
};

/** S6 local-only foreground claim: set before blocking, cleared on demote/exit. */
export const setForegroundClaim = (spoolDir: string, jobId: string): boolean => {
  const record = readJsonFile<JobRecord>(jobJsonPath(spoolDir, jobId));
  if (!record || record.status !== "running") return false;
  record.foregroundClaim = true;
  record.claimHeartbeatAt = new Date().toISOString();
  atomicWriteJson(jobJsonPath(spoolDir, jobId), record);
  return true;
};

export const refreshForegroundClaim = (spoolDir: string, jobId: string): boolean =>
  setForegroundClaim(spoolDir, jobId);

export const clearForegroundClaim = (spoolDir: string, jobId: string): void => {
  const record = readJsonFile<JobRecord>(jobJsonPath(spoolDir, jobId));
  if (!record) return;
  record.foregroundClaim = false;
  atomicWriteJson(jobJsonPath(spoolDir, jobId), record);
};

export const clearAllForegroundClaims = (spoolDir: string): number => {
  let cleared = 0;
  let files: string[];
  try {
    files = readdirSync(jobsDir(spoolDir));
  } catch {
    return 0;
  }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const jobId = file.slice(0, -".json".length);
    const record = readJsonFile<JobRecord>(jobJsonPath(spoolDir, jobId));
    if (record?.foregroundClaim) {
      record.foregroundClaim = false;
      atomicWriteJson(jobJsonPath(spoolDir, jobId), record);
      cleared += 1;
    }
  }
  return cleared;
};


