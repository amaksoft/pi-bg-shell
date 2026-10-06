import { execFileSync } from "node:child_process";
import { readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { acquireOwnerLock, readOwner, releaseOwnerLock } from "./owner-lock";
import { atomicWriteJson, readJsonFile, type DeathRecord, type SessionRecord } from "./sidecar";
import { sessionJsonPath, sessionLockPath, tmuxSocketDir } from "./naming";

export { tmuxSocketDir };

/**
 * P3/S4: stale-session reaper. Runs when a pi process is alive (session_start;
 * lazy reaper-on-next-start covers nobody-home). Kills ONLY provably-dead, non-leave-running
 * engine sessions: name match + acquirable flock + stale heartbeat + dead pid,
 * GUID-verified, one server at a time. Writes death.json before killing so
 * salvage can distinguish reaped sessions from live ones.
 */

export interface ReaperProbes {
  /** Private-server socket names to consider (pi-bg- namespace only). */
  listSockets(): string[];
  /** Live session names on a socket. */
  listSessions(socket: string): string[];
  /** Live @pi_guid of a session, or undefined when unreadable. */
  sessionGuid(socket: string, session: string): string | undefined;
  /** Destroy a private server (all its sessions). */
  killServer(socket: string): void;
  /** tmux socket dir for prefix scans (default implementation). */
  socketDir?(): string;
}

export interface ReapedSession {
  socket: string;
  spoolDir: string;
  sessionName: string;
  jobs: number;
}

export interface ReaperResult {
  reaped: ReapedSession[];
  skippedLeaveRunning: string[];
  skippedLive: string[];
  errors: { spoolDir: string; error: string }[];
}

export const defaultReaperProbes = (tmuxBinary: string): ReaperProbes => ({
  listSockets(): string[] {
    let entries: string[];
    try {
      entries = readdirSync(tmuxSocketDir());
    } catch {
      return [];
    }
    return entries.filter((name) => name.startsWith("pi-bg-"));
  },
  listSessions(socket: string): string[] {
    try {
      const out = execFileSync(tmuxBinary, ["-L", socket, "list-sessions", "-F", "#{session_name}"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return String(out).split("\n").map((line) => line.trim()).filter(Boolean);
    } catch {
      return [];
    }
  },
  sessionGuid(socket: string, session: string): string | undefined {
    try {
      const out = execFileSync(tmuxBinary, ["-L", socket, "display-message", "-p", "-t", session, "#{@pi_guid}"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const guid = String(out).trim();
      return guid.length > 0 ? guid : undefined;
    } catch {
      return undefined;
    }
  },
  killServer(socket: string): void {
    execFileSync(tmuxBinary, ["-L", socket, "kill-server"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
  },
});

/**
 * Reap dead engine sessions under spoolRoot. Never touches legacy
 * `pi-background*` (S4 flag-day: old code owns them while it exists).
 */
export const runReaper = (
  spoolRoot: string,
  staleAfterMs: number,
  probes: ReaperProbes,
): ReaperResult => {
  const result: ReaperResult = { reaped: [], skippedLeaveRunning: [], skippedLive: [], errors: [] };
  let dirs: string[];
  try {
    dirs = readdirSync(spoolRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(spoolRoot, entry.name));
  } catch {
    return result;
  }
  for (const spoolDir of dirs) {
    try {
      reapOneDir(spoolDir, staleAfterMs, probes, result);
    } catch (error) {
      result.errors.push({
        spoolDir,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
};

const reapOneDir = (
  spoolDir: string,
  staleAfterMs: number,
  probes: ReaperProbes,
  result: ReaperResult,
): void => {
  const record = readJsonFile<SessionRecord>(sessionJsonPath(spoolDir));
  if (!record || record.version !== 1) return; // not ours: never touch
  if (record.shutdownPolicy === "leave-running") {
    result.skippedLeaveRunning.push(spoolDir);
    return;
  }
  const lockDir = sessionLockPath(spoolDir);
  const owner = readOwner(lockDir);
  // Owner-dead conjunction (S4): acquirable flock AND stale heartbeat AND
  // dead/recycled pid. A live holder fails the non-blocking attempt below.
  const acquired = acquireOwnerLock(lockDir, staleAfterMs);
  if (acquired.outcome === "live") {
    result.skippedLive.push(spoolDir);
    return;
  }
  try {
    // We hold the lock, so no live owner exists. Double-check staleness
    // against the PREVIOUS owner (not our fresh takeover touch): the fact
    // that takeover succeeded already proves the conjunction.
    void owner;
    const socket = socketFromRecord(record);
    if (!socket) {
      result.errors.push({ spoolDir, error: "no socket in sidecar" });
      return;
    }
    const liveSessions = probes.listSessions(socket);
    if (liveSessions.includes(record.sessionName)) {
      // GUID-verified kill only: never murder a recycled/foreign session.
      const liveGuid = probes.sessionGuid(socket, record.sessionName);
      if (liveGuid !== record.sessionGuid) {
        result.errors.push({ spoolDir, error: `guid mismatch (live=${liveGuid})` });
        return;
      }
      probes.killServer(socket);
    }
    // Tombstone BEFORE releasing: salvage must see reason + job inventory.
    atomicWriteJson(join(spoolDir, "death.json"), tombstone(spoolDir, "reaped", 0));
    result.reaped.push({ socket, spoolDir, sessionName: record.sessionName, jobs: tombstoneJobCount(spoolDir) });
  } finally {
    releaseOwnerLock(lockDir, acquired.owner.nonce);
  }
};

const socketFromRecord = (record: SessionRecord): string | undefined => {
  const match = /^-L\s+(\S+)/.exec(record.tmuxServer ?? "");
  return match?.[1];
};

const tombstoneJobCount = (spoolDir: string): number => {
  try {
    return readdirSync(join(spoolDir, "jobs")).filter((f) => f.endsWith(".json")).length;
  } catch {
    return 0;
  }
};

/**
 * Crash-window tmp sweep: atomicWriteJson stages `.tmp-*.json` beside its
 * target, so a kill between create and rename orphans one. Only files
 * matching our prefix AND older than the window go — a live write's tmp is
 * seconds old. Files only, never directories; best-effort, never throws.
 * Returns swept file paths.
 */
export const TMP_SWEEP_PREFIX = ".tmp-";
export const TMP_SWEEP_AGE_MS = 3600000;
export const sweepTmpFiles = (spoolRoot: string, olderThanMs = TMP_SWEEP_AGE_MS): string[] => {
  const swept: string[] = [];
  const cutoff = Date.now() - olderThanMs;
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.startsWith(TMP_SWEEP_PREFIX)) continue;
      try {
        if (statSync(full).mtimeMs > cutoff) continue;
        unlinkSync(full);
        swept.push(full);
      } catch {
        // Racy delete or perms — leave it for the next pass.
      }
    }
  };
  walk(spoolRoot);
  return swept;
};

/**
 * Retention prune (contract: preservedOutputRetentionDays / maxPreservedOutputMb).
 * Only tombstoned dirs are eligible — a live or untombstoned dir is never
 * deleted, no matter its age. Oldest tombstones go first under the size cap.
 * Returns pruned dir paths.
 */
export const pruneSpool = (
  spoolRoot: string,
  retentionDays: number,
  maxMb: number,
): string[] => {
  const pruned: string[] = [];
  let dirs: string[];
  try {
    dirs = readdirSync(spoolRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(spoolRoot, entry.name));
  } catch {
    return pruned;
  }
  const ageCutoff = Date.now() - retentionDays * 86400000;
  const tombstoned: { dir: string; mtime: number }[] = [];
  for (const dir of dirs) {
    let deathMtime = 0;
    try {
      deathMtime = statSync(join(dir, "death.json")).mtimeMs;
    } catch {
      continue; // not tombstoned: never eligible
    }
    if (deathMtime < ageCutoff) {
      rmSync(dir, { recursive: true, force: true });
      pruned.push(dir);
    } else {
      tombstoned.push({ dir, mtime: deathMtime });
    }
  }
  if (maxMb > 0) {
    let total = spoolSizeBytes(spoolRoot);
    tombstoned.sort((a, b) => a.mtime - b.mtime);
    for (const { dir } of tombstoned) {
      if (total <= maxMb * 1024 * 1024) break;
      const before = dirSizeBytes(dir);
      rmSync(dir, { recursive: true, force: true });
      pruned.push(dir);
      total -= before;
    }
  }
  return pruned;
};

const dirSizeBytes = (dir: string): number => {
  let total = 0;
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += dirSizeBytes(path);
      else total += statSync(path).size;
    } catch {
      // Racy deletes: ignore.
    }
  }
  return total;
};

const spoolSizeBytes = (spoolRoot: string): number => dirSizeBytes(spoolRoot);

const tombstone = (spoolDir: string, reason: DeathRecord["reason"], missCount: number): DeathRecord => {
  let jobs: DeathRecord["jobs"] = [];
  try {
    jobs = readdirSync(join(spoolDir, "jobs"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const r = readJsonFile<{ jobId?: string; status?: string; exitFile?: string }>(join(spoolDir, "jobs", f)) ?? {};
        let exitFilePresent = false;
        if (r.exitFile) {
          try {
            statSync(r.exitFile);
            exitFilePresent = true;
          } catch {
            try {
              statSync(`${r.exitFile}.consumed`);
              exitFilePresent = true;
            } catch {
              exitFilePresent = false;
            }
          }
        }
        return {
          jobId: r.jobId ?? f.replace(/\.json$/, ""),
          lastState: r.status ?? "unknown",
          exitFilePresent,
        };
      });
  } catch {
    jobs = [];
  }
  return { killedAt: new Date().toISOString(), reason, missCount, jobs };
};

/**
 * Socket-file garbage collection.
 *
 * Dead tmux servers leave orphaned socket files behind (tmux only unlinks
 * its socket on a clean exit — kill -9, crashes, and interrupted test runs
 * all leak one). This sweep removes them so abnormal deaths self-clean
 * within a bounded time instead of accumulating.
 *
 * Safety is a triple gate; ANY unverifiable state means "do nothing":
 *  1. Prefix gate — only our `pi-bg-` namespace (never default, cc-*, or perf-*).
 *  2. Age gate — socket file older than minAgeMs. A starting server's
 *     socket is always fresh, so the startup race (exists but not serving
 *     yet) can never be collected.
 *  3. Liveness gate — tmux itself must report no-server for that exact
 *     socket. Live, erroring, or timing-out probes all skip.
 * Plus a type gate: unlink files/sockets only, never directories; and an
 * action gate: unlink only, never kill — a misidentified server cannot be
 * harmed by removing nothing... rather, cannot be harmed at all, because
 * only proven-dead sockets are unlinked.
 */

export const DEFAULT_SOCKET_PREFIXES = ["pi-bg-"];
export const SOCKET_MIN_AGE_MS = 120_000;
const SOCKET_PROBE_TIMEOUT_MS = 10_000;

export interface SocketEntry {
  name: string;
  mtimeMs: number;
  isDirectory: boolean;
}

export interface DeadSocketProbes {
  /** Socket-dir entries, or undefined when the dir is unreadable. */
  listSocketEntries(): SocketEntry[] | undefined;
  /** Liveness of one socket: "unknown" covers errors and timeouts. */
  socketState(socket: string): "live" | "dead" | "unknown";
  /** Remove one socket file; throws on failure (ENOENT included). */
  unlinkSocket(socket: string): void;
}

export interface SocketSweepResult {
  collected: string[];
  skippedLive: string[];
  skippedFresh: string[];
  skippedUnknown: string[];
  errors: { socket: string; error: string }[];
}

export const defaultDeadSocketProbes = (tmuxBinary: string): DeadSocketProbes => ({
  listSocketEntries(): SocketEntry[] | undefined {
    let dir: string;
    try {
      dir = tmuxSocketDir();
    } catch {
      return undefined;
    }
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return undefined;
    }
    const out: SocketEntry[] = [];
    for (const name of entries) {
      try {
        const st = statSync(join(dir, name));
        out.push({ name, mtimeMs: st.mtimeMs, isDirectory: st.isDirectory() });
      } catch {
        // Racy delete between readdir and stat: treat as already gone.
      }
    }
    return out;
  },
  socketState(socket: string): "live" | "dead" | "unknown" {
    try {
      execFileSync(tmuxBinary, ["-L", socket, "list-sessions", "-F", "#{session_name}"], {
        encoding: "utf-8",
        timeout: SOCKET_PROBE_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return "live";
    } catch (error) {
      const msg = [stderrOf(error), messageOf(error)].join("\n");
      if (/no server running/i.test(msg)) return "dead";
      return "unknown";
    }
  },
  unlinkSocket(socket: string): void {
    const path = join(tmuxSocketDir(), socket);
    const st = statSync(path);
    if (st.isDirectory()) throw new Error(`refusing to unlink directory: ${path}`);
    unlinkSync(path);
  },
});

const stderrOf = (error: unknown): string => {
  const stderr = (error as { stderr?: unknown })?.stderr;
  return typeof stderr === "string" ? stderr : Buffer.isBuffer(stderr) ? stderr.toString("utf-8") : "";
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Collect dead-server socket files. Fail-safe: prefix + age + liveness must
 * ALL hold, otherwise the entry is skipped (never an error).
 */
export const sweepDeadSockets = (
  tmuxBinary: string,
  opts: { prefixes?: string[]; minAgeMs?: number; probes?: DeadSocketProbes } = {},
): SocketSweepResult => {
  const result: SocketSweepResult = {
    collected: [],
    skippedLive: [],
    skippedFresh: [],
    skippedUnknown: [],
    errors: [],
  };
  const prefixes = opts.prefixes ?? DEFAULT_SOCKET_PREFIXES;
  const minAgeMs = opts.minAgeMs ?? SOCKET_MIN_AGE_MS;
  const probes = opts.probes ?? defaultDeadSocketProbes(tmuxBinary);
  let entries: SocketEntry[] | undefined;
  try {
    entries = probes.listSocketEntries();
  } catch (error) {
    result.errors.push({ socket: "<socket-dir>", error: messageOf(error) });
    return result;
  }
  if (!entries) return result;
  const now = Date.now();
  for (const entry of entries) {
    if (!prefixes.some((prefix) => entry.name.startsWith(prefix))) continue;
    if (entry.isDirectory) {
      result.errors.push({ socket: entry.name, error: "unexpected directory under our prefix" });
      continue;
    }
    if (now - entry.mtimeMs < minAgeMs) {
      result.skippedFresh.push(entry.name);
      continue;
    }
    let state: "live" | "dead" | "unknown";
    try {
      state = probes.socketState(entry.name);
    } catch (error) {
      result.errors.push({ socket: entry.name, error: messageOf(error) });
      continue;
    }
    if (state === "live") {
      result.skippedLive.push(entry.name);
      continue;
    }
    if (state !== "dead") {
      result.skippedUnknown.push(entry.name);
      continue;
    }
    try {
      probes.unlinkSocket(entry.name);
      result.collected.push(entry.name);
    } catch (error) {
      // ENOENT converges: someone else already cleaned it — goal reached.
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        result.collected.push(entry.name);
      } else {
        result.errors.push({ socket: entry.name, error: messageOf(error) });
      }
    }
  }
  return result;
};
