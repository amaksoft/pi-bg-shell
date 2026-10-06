import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * P0 (Rev 3 R1): pid-free identity for 1:1 tmux sessions on private servers.
 * The creating OS pid is NEVER part of any lookup key.
 */

export const SESSION_PREFIX = "pi-bg-";
export const SOCKET_HASH_HEX = 12;

const shortHash = (piId: string): string =>
  createHash("sha256").update(piId, "utf8").digest("hex").slice(0, SOCKET_HASH_HEX);

/** Canonical tmux session name for a pi session id. */
export const canonicalSessionName = (piId: string): string => `${SESSION_PREFIX}${piId}`;

/**
 * Private tmux server socket name. Short hash keeps the socket path under
 * the 108-char Unix limit no matter how long the pi id is.
 */
export const serverSocketName = (piId: string): string =>
  `${SESSION_PREFIX}${shortHash(piId)}`;



/** Canonical spool dir: <spoolRoot>/<pi-id>/ (S2). */
export const canonicalSpoolDir = (spoolRoot: string, piId: string): string =>
  join(spoolRoot, piId);


export const sessionJsonPath = (spoolDir: string): string => join(spoolDir, "session.json");
export const sessionLockPath = (spoolDir: string): string => join(spoolDir, "session.lock");
export const heartbeatPath = (spoolDir: string): string => join(spoolDir, "heartbeat");
export const jobsDir = (spoolDir: string): string => join(spoolDir, "jobs");
export const jobJsonPath = (spoolDir: string, jobId: string): string =>
  join(jobsDir(spoolDir), `${jobId}.json`);
export const deathJsonPath = (spoolDir: string): string => join(spoolDir, "death.json");

/**
 * tmux socket directory. tmux resolves `-L <name>` under $TMUX_TMPDIR when
 * set, always appending a per-UID `tmux-<uid>` segment (verified: a server
 * created with TMUX_TMPDIR=$D lands its socket at $D/tmux-$UID/<name>).
 * All private-server sockets resolve under this directory.
 */
export const tmuxSocketDir = (): string => {
  try {
    const uid = process.getuid?.() ?? 0;
    const override = process.env.TMUX_TMPDIR;
    if (override) return join(override, `tmux-${uid}`);
    return `/tmp/tmux-${uid}`;
  } catch {
    return join(tmpdir(), `tmux-${process.pid}`);
  }
};
