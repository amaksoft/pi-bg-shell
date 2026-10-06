import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * P0 (S2): crash-safe sidecar persistence. Every write is tmp+fsync+rename,
 * so a crash can only ever leave the previous complete version or nothing —
 * never a torn file. Readers treat missing/corrupt files as absent.
 */

export interface SessionRecord {
  piId: string;
  sessionName: string;
  sessionGuid: string;
  tmuxServer: string;
  shutdownPolicy: string;
  version: 1;
  createdAt: string;
  ownerNonce: string;
  state: "creating" | "active";
  /**
   * Ownership generation: bumped on every in-place takeover of this dir.
   * Kill decisions re-read it and abort on movement (STALE_EPOCH).
   * Absent on pre-epoch records: treated as 0.
   */
  epoch?: number;
  /** Foreign spool dirs this session adopted (restored on restart). */
  adoptedDirs?: string[];
}

export interface JobRecord {
  jobId: string;
  windowId: string;
  command: string;
  windowName?: string;
  /** Human label (model-provided `name` or auto-namer fallback). */
  name?: string;
  startedAt: number;
  spoolLog: string;
  exitFile: string;
  foregroundClaim: boolean;
  claimHeartbeatAt?: string;
  status: "running" | "completed" | "killed";
  /**
   * Seen latch (patty-bg-tasks idea, journal-durable): set by any path that
   * surfaces the outcome (peek/read, deliberate kill) BEFORE delivery,
   * suppressing the pending completion ping. Survives restarts.
   */
  seen: boolean;
}

export interface DeathRecord {
  killedAt: string;
  reason: "owner-gone" | "reaped";
  missCount: number;
  jobs: { jobId: string; lastState: string; exitFilePresent: boolean }[];
}

/** Atomic JSON write: tmp file in the OS tmpdir, fsync, rename over target. */
export const atomicWriteJson = (targetPath: string, value: unknown): void => {
  const stamp = `${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const tmpPath = join(tmpdir(), `pi-bg-sidecar-${stamp}.json`);
  const fd = openSync(tmpPath, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(value, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, targetPath);
};

/**
 * Read JSON, returning undefined for missing files AND corrupt content.
 * A torn write can never be observed (rename is atomic), but a corrupt file
 * must still fail soft — never throw on the read path.
 */
export const readJsonFile = <T>(filePath: string): T | undefined => {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
};

/** Best-effort unlink; missing files are fine. */
export const unlinkIfPresent = (filePath: string): void => {
  try {
    unlinkSync(filePath);
  } catch {
    // Already gone — fine.
  }
};

/** Idempotent mkdir -p for spool dirs (benign under creator races). */
export const ensureDir = (dir: string): void => {
  mkdirSync(dir, { recursive: true });
};
