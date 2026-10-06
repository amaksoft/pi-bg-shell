import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { atomicWriteJson, readJsonFile } from "./sidecar";

/**
 * The owner lock. mkdir-atomicity instead of flock(1) — portable (macOS has
 * no flock(1)), same semantics: exclusive, non-blocking attempt, stale
 * detection via heartbeat mtime, plus a best-effort pid guard.
 *
 * The pid guard exists because heartbeat-only liveness has one sharp edge:
 * a scheduler-stalled LIVE owner (frozen heartbeat past the threshold)
 * reads dead. So a stale heartbeat still defers to a provably-live pid
 * (signal 0 succeeds or EPERM): that combination means stalled, not dead.
 * No start-time matrix, no /proc parsing — pid REUSE inside the stale
 * window is accepted (requires same-number reuse plus a stale heartbeat;
 * GUID fencing + journal status bound that blast radius).
 *
 * Layout: <spoolDir>/session.lock/  (a directory; mkdir is O_EXCL-atomic)
 *   owner.json  { nonce, heartbeatAt, pid? }
 *   heartbeat   (empty file, touched every tick; mtime is the fast signal)
 */

export interface OwnerInfo {
  nonce: string;
  heartbeatAt: string;
  /** Best-effort stall guard (see header). Absent on pre-pid records. */
  pid?: number;
}

const OWNER_FILE = "owner.json";
const HEARTBEAT_FILE = "heartbeat";

const nowIso = (): string => new Date().toISOString();

const touchHeartbeat = (lockDir: string): void => {
  writeFileSync(join(lockDir, HEARTBEAT_FILE), "");
};

const heartbeatAgeMs = (lockDir: string): number | null => {
  try {
    return Date.now() - statSync(join(lockDir, HEARTBEAT_FILE)).mtimeMs;
  } catch {
    return null;
  }
};

const removeLockDir = (lockDir: string): void => {
  rmSync(lockDir, { recursive: true, force: true });
};

export type LockProbe = "acquired" | "live";

/**
 * Non-blocking exclusive acquire. Returns 'acquired' when we own the lock
 * (fresh create or stale-heartbeat takeover), 'live' when the heartbeat is
 * fresh. NEVER blocks.
 *
 * Takeover requires: lock dir present AND heartbeat older than staleAfterMs
 * (or unreadable). A lock dir with no owner record claims nothing (crashed
 * mid-write): take it over rather than wedging forever.
 */
export const acquireOwnerLock = (
  lockDir: string,
  staleAfterMs: number,
): { outcome: LockProbe; owner: OwnerInfo } => {
  try {
    mkdirSync(lockDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = readJsonFile<OwnerInfo>(join(lockDir, OWNER_FILE));
    if (!existing || isOwnerDead(lockDir, existing, staleAfterMs)) {
      removeLockDir(lockDir);
      try {
        mkdirSync(lockDir);
      } catch (error) {
        // Lost the takeover race (concurrent taker won): back off, no dual owners.
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const winner = readJsonFile<OwnerInfo>(join(lockDir, OWNER_FILE));
        return { outcome: "live", owner: winner ?? deadPlaceholder() };
      }
    } else {
      return { outcome: "live", owner: existing ?? deadPlaceholder() };
    }
  }
  const owner: OwnerInfo = {
    nonce: randomUUID(),
    heartbeatAt: nowIso(),
    pid: process.pid,
  };
  atomicWriteJson(join(lockDir, OWNER_FILE), owner);
  touchHeartbeat(lockDir);
  // Re-verify we still hold it: a concurrent taker that rm -rf'd between
  // our mkdir and write would have deleted our record. Mismatch backs off.
  const check = readJsonFile<OwnerInfo>(join(lockDir, OWNER_FILE));
  if (!check || check.nonce !== owner.nonce) {
    const current = check ?? deadPlaceholder();
    return { outcome: "live", owner: current };
  }
  return { outcome: "acquired", owner };
};

const deadPlaceholder = (): OwnerInfo => ({
  nonce: "",
  heartbeatAt: new Date(0).toISOString(),
  pid: -1,
});

/**
 * Dead-owner test: fresh heartbeat means alive, full stop. A stale (or
 * unreadable) heartbeat means dead UNLESS signal 0 proves the recorded pid
 * is still alive — that combination reads as scheduler-stalled, not dead.
 * Unprovable states (ESRCH-dead aside) defer to the heartbeat verdict.
 */
export const isOwnerDead = (
  lockDir: string,
  owner: OwnerInfo,
  staleAfterMs: number,
): boolean => {
  const age = heartbeatAgeMs(lockDir);
  if (age !== null && age < staleAfterMs) return false;
  if (owner.pid !== undefined && owner.pid > 0 && pidAlive(owner.pid)) return false;
  return true;
};

/** Best-effort aliveness: signal 0 success or EPERM means a live process. */
const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Refresh heartbeat (owner tick). No-op unless we hold the lock (nonce match). */
export const refreshOwnerLock = (lockDir: string, nonce: string): boolean => {
  const owner = readJsonFile<OwnerInfo>(join(lockDir, OWNER_FILE));
  if (!owner || owner.nonce !== nonce) return false;
  owner.heartbeatAt = nowIso();
  atomicWriteJson(join(lockDir, OWNER_FILE), owner);
  touchHeartbeat(lockDir);
  return true;
};

/** Release only our own lock (nonce match). Always safe to call. */
export const releaseOwnerLock = (lockDir: string, nonce: string): void => {
  const owner = readJsonFile<OwnerInfo>(join(lockDir, OWNER_FILE));
  if (!owner || owner.nonce !== nonce) return;
  removeLockDir(lockDir);
};

export const readOwner = (lockDir: string): OwnerInfo | undefined =>
  readJsonFile<OwnerInfo>(join(lockDir, OWNER_FILE));
