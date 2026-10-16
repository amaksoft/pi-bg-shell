import { randomUUID } from "node:crypto";
import { lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  canonicalSessionName,
  canonicalSpoolDir,
  deathJsonPath,
  jobsDir,
  serverSocketName,
  sessionJsonPath,
  sessionLockPath,
  tmuxSocketDir,
} from "./naming";
import { acquireOwnerLock, isOwnerDead, readOwner, refreshOwnerLock, releaseOwnerLock } from "./owner-lock";
import { atomicWriteJson, ensureDir, readJsonFile, type SessionRecord } from "./sidecar";

export const GUID_OPTION = "@pi_guid";

/** Thrown when a live owner holds the pi id (S1 busy-exit — never auto-split). */
export class SessionBusyError extends Error {
  readonly piId: string;
  constructor(piId: string) {
    super(`session busy, original pi still alive (pi id ${piId})`);
    this.name = "SessionBusyError";
    this.piId = piId;
  }
}

export interface Runner {
  /** Run tmux against the owned private server; throws on failure. */
  tmux(socketName: string, args: string[]): string;
}

export interface EnsureSessionParams {
  piId: string;
  spoolRoot: string;
  shutdownPolicy: string;
  staleAfterMs: number;
  runner: Runner;
}

export interface Session {
  piId: string;
  spoolDir: string;
  sessionName: string;
  socketName: string;
  sessionGuid: string;
  ownerNonce: string;
  /** Ownership generation this object was created under (see SessionRecord). */
  epoch: number;
}

const readGuidOption = (params: EnsureSessionParams, socket: string, session: string): string | undefined => {
  try {
    const out = params.runner.tmux(socket, [
      "show-options",
      "-t",
      session,
      "-v",
      GUID_OPTION,
    ]);
    const guid = out.trim();
    return guid.length > 0 ? guid : undefined;
  } catch {
    return undefined;
  }
};

/**
 * P0 (S1/S2): ensure the 1:1 session. Full creation order —
 * mkdir spool (idempotent) → lock BEFORE any JSON (creator race closes here)
 * → session.json 'creating' → tmux new-session → set-option guid →
 * read-back verify (repair once) → session.json 'active'.
 *
 * Live owner → SessionBusyError. Stale owner + leftover session →
 * reclaimed in place. Existing live session
 * with matching sidecar → idempotent return (same-pi-id retry after crash
 * between steps is safe: creating+live+matching guid repairs forward).
 */
export const ensureSession = (params: EnsureSessionParams): Session => {
  const { piId } = params;
  const spoolDir = canonicalSpoolDir(params.spoolRoot, piId);
  const lockDir = sessionLockPath(spoolDir);
  // Symlinked spool roots escape confinement (lock + sidecar guarantees
  // assume a real dir): refuse loudly instead of operating through one.
  for (const dir of [params.spoolRoot, spoolDir]) {
    try {
      if (lstatSync(dir).isSymbolicLink()) {
        throw new Error(`spool dir must not be a symlink: ${dir}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("spool dir must not")) throw error;
      // Missing dir is fine (created below); other stat failures surface there.
    }
  }
  ensureDir(spoolDir);
  ensureDir(jobsDir(spoolDir));

  const acquired = acquireOwnerLock(lockDir, params.staleAfterMs);
  if (acquired.outcome === "live") throw new SessionBusyError(piId);

  const sessionName = canonicalSessionName(piId);
  const socketName = serverSocketName(piId);
  const guid = randomUUID();
  const createdAt = new Date().toISOString();
  // Preserve previously adopted dirs across restarts (restored below).
  // Epoch bumps on every in-place takeover of this dir.
  const previous = readJsonFile<SessionRecord>(sessionJsonPath(spoolDir));
  const previousAdopted = previous?.adoptedDirs;
  const epoch = (previous?.epoch ?? -1) + 1;
  atomicWriteJson(sessionJsonPath(spoolDir), {
    piId,
    sessionName,
    sessionGuid: guid,
    tmuxServer: `-L ${socketName}`,
    shutdownPolicy: params.shutdownPolicy,
    version: 1,
    createdAt,
    ownerNonce: acquired.owner.nonce,
    epoch,
    state: "creating",
    ...(previousAdopted?.length ? { adoptedDirs: previousAdopted } : {}),
  } satisfies SessionRecord);

  const created = createSessionOnServer(params, socketName, sessionName, guid, params.shutdownPolicy);
  if (created === "foreign") {
    // Leftover session on our socket that resists reclaim: fail closed,
    // never touch foreign.
    throw new SessionBusyError(piId);
  }

  atomicWriteJson(sessionJsonPath(spoolDir), {
    piId,
    sessionName,
    sessionGuid: guid,
    tmuxServer: `-L ${socketName}`,
    shutdownPolicy: params.shutdownPolicy,
    version: 1,
    createdAt,
    ownerNonce: acquired.owner.nonce,
    epoch,
    state: "active",
    ...(previousAdopted?.length ? { adoptedDirs: previousAdopted } : {}),
  } satisfies SessionRecord);
  touchHeartbeatFile(spoolDir);
  // The bootstrap window stays: tmux sessions cannot survive zero windows,
  // so it pins the session between jobs (no loop, no suicide). It never holds
  // a job (no journal, no @pi_job_id) and job surfaces list from journals,
  // so it is invisible to /tasks, footer, and delivery.
  return {
    piId,
    spoolDir,
    sessionName,
    socketName,
    sessionGuid: guid,
    ownerNonce: acquired.owner.nonce,
    epoch,
  };
};

/**
 * Ensure the session exists with the expected guid (repairing once if
 * needed). Returns "created" (we made it), "reclaimed" (leftover with a
 * dead owner, re-tagged to us), or "foreign" (resists repair: hands off).
 */
const createSessionOnServer = (
  params: EnsureSessionParams,
  socket: string,
  session: string,
  guid: string,
  shutdownPolicy: string,
): "created" | "reclaimed" | "foreign" => {
  const existing = sessionAlive(params, socket, session);
  if (!existing) {
    params.runner.tmux(socket, ["new-session", "-d", "-s", session, "-x", "200", "-y", "50"]);
  }
  applyGuidOptions(params.runner, socket, session, guid);
  const verified = readGuidOption(params, socket, session);
  if (verified === guid) return existing ? "reclaimed" : "created";
  // Crash between new-session and set-option: repair once from the sidecar, then re-verify.
  applyGuidOptions(params.runner, socket, session, guid);
  if (readGuidOption(params, socket, session) === guid) return existing ? "reclaimed" : "created";
  // Genuinely foreign session (guid mismatch after repair): do not touch it.
  return "foreign";
};

const sessionAlive = (params: EnsureSessionParams, socket: string, session: string): boolean => {
  try {
    params.runner.tmux(socket, ["has-session", "-t", session]);
    return true;
  } catch {
    return false;
  }
};

/** Pin the session GUID (single set-option; the kill predicate reads it back). */
const applyGuidOptions = (runner: Runner, socket: string, session: string, guid: string): void => {
  runner.tmux(socket, ["set-option", "-t", session, GUID_OPTION, guid]);
};

/**
 * Liveness probe: true when the tmux session exists on our private server.
 * When `expectedGuid` is given, a live session with a mismatched guid
 * reads as NOT alive (foreign/recycled) so callers fail closed instead of
 * operating on someone else's session.
 */
export const isSessionAlive = (
  runner: Runner,
  socketName: string,
  sessionName: string,
  expectedGuid?: string,
): boolean => {
  try {
    runner.tmux(socketName, ["has-session", "-t", sessionName]);
  } catch {
    return false;
  }
  if (expectedGuid === undefined) return true;
  try {
    const live = runner
      .tmux(socketName, ["show-options", "-t", sessionName, "-v", GUID_OPTION])
      .trim();
    // Empty read is inconclusive (older tmux / race): treat as alive so we
    // don't recreate over a session we simply couldn't verify. A present
    // but mismatched guid is proof of foreignness → not alive.
    if (!live) return true;
    return live === expectedGuid;
  } catch {
    return true;
  }
};

export type EnsureLiveResult = { ok: true; recovered: boolean } | { ok: false; reason: string };

/**
 * Recover a dead tmux session without restart. We already hold the owner
 * lock for this spool dir, so recreating the session in place is safe:
 * same socket, same session name, SAME guid (identity preserved, no epoch
 * bump, no sidecar rewrite — the existing Session object stays valid).
 *
 * Returns `{ ok: true, recovered: false }` when already alive,
 * `{ ok: true, recovered: true }` after a successful recreate, or
 * `{ ok: false }` when the live session resists repair (foreign guid) or
 * tmux keeps failing. Never throws — callers branch on the result.
 */
export const ensureLiveSession = (session: Session, runner: Runner): EnsureLiveResult => {
  // Fast path: session present. A mismatched guid here means a foreign
  // session somehow owns our name — fail closed, never steal it.
  try {
    runner.tmux(session.socketName, ["has-session", "-t", session.sessionName]);
    try {
      const liveGuid = runner
        .tmux(session.socketName, ["show-options", "-t", session.sessionName, "-v", GUID_OPTION])
        .trim();
      if (liveGuid && liveGuid !== session.sessionGuid) {
        return { ok: false, reason: "foreign session owns our name (guid mismatch)" };
      }
    } catch {
      // Unverifiable guid: session exists, proceed as alive.
    }
    return { ok: true, recovered: false };
  } catch {
    // Session/server gone — fall through to recreate.
  }
  try {
    runner.tmux(session.socketName, ["new-session", "-d", "-s", session.sessionName, "-x", "200", "-y", "50"]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // Lost the race (someone recreated between has-session and new-session):
    // treat as alive and re-verify below instead of failing.
    if (!/duplicate session|session.*exists|already/i.test(detail)) {
      // new-session can also fail when the server is mid-death; one retry
      // covers the transient. A second failure is real.
      try {
        runner.tmux(session.socketName, ["new-session", "-d", "-s", session.sessionName, "-x", "200", "-y", "50"]);
      } catch (retryError) {
        const retryDetail = retryError instanceof Error ? retryError.message : String(retryError);
        if (!/duplicate session|session.*exists|already/i.test(retryDetail)) {
          return { ok: false, reason: `new-session failed: ${retryDetail.split("\n")[0]}` };
        }
      }
    }
  }
  try {
    runner.tmux(session.socketName, ["set-option", "-t", session.sessionName, GUID_OPTION, session.sessionGuid]);
    let verified: string | undefined;
    try {
      const out = runner.tmux(session.socketName, ["show-options", "-t", session.sessionName, "-v", GUID_OPTION]);
      const guid = out.trim();
      verified = guid.length > 0 ? guid : undefined;
    } catch {
      verified = undefined;
    }
    if (verified !== undefined && verified !== session.sessionGuid) {
      return { ok: false, reason: "guid verify failed after recreate (foreign session?)" };
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `guid tagging failed: ${detail.split("\n")[0]}` };
  }
  return { ok: true, recovered: true };
};

const touchHeartbeatFile = (spoolDir: string): void => {
  try {
    refreshOwnerLock(sessionLockPath(spoolDir), readOwner(sessionLockPath(spoolDir))?.nonce ?? "");
  } catch {
    // Heartbeat file is best-effort at create time; the tick owns it after.
  }
};

/**
 * Shutdown: destroy the private server (all sessions die with it) unless
 * leave-running, then release the lock. Tombstoned state is untouched —
 * death.json is written only by the reaper, never here.
 */
/**
 * Server destroy (shutdown path). Not routed through killGuarded: servers
 * are destroy operations, not window kills, and this runs while WE hold the
 * lock with a fresh heartbeat (no takeover possible, so the server is ours).
 * The full kill taxonomy: window kills → killGuarded (GUID-predicated);
 * dead-session servers → reaper (GUID-verified before its killServer probe);
 * own server here. Every kill site is fenced or owned-context; none kills
 * by bare name/id.
 */
export const destroySession = (
  session: Session,
  runner: Runner,
  leaveRunning: boolean,
): void => {
  if (!leaveRunning) {
    let killed = false;
    // Best-effort GUID verify: a takeover between tick-stop and destroy
    // must not bury the new owner's server. Mismatch (or unreadable)
    // skips the kill; the lock release below is nonce-guarded either way.
    // (Unreadable GUID fails OPEN to killing: the alternative strands our
    // own server whenever show-option hiccups. The sweep reaps orphans.)
    let guidOk = true;
    try {
      const liveGuid = runner
        .tmux(session.socketName, ["display-message", "-p", "-t", session.sessionName, "#{@pi_guid}"])
        .trim();
      if (liveGuid && liveGuid !== session.sessionGuid) guidOk = false;
    } catch {
      // Unreadable: fall through to kill (see note above).
    }
    if (guidOk) {
      try {
        runner.tmux(session.socketName, ["kill-server"]);
        killed = true;
      } catch {
        // Server already gone — fine. Socket state unknown, so leave the
        // file for the sweep (which verifies before unlinking).
      }
    }
    if (killed) {
      // Best-effort: clean exits normally unlink the socket, but a racing
      // death can leave it behind. Only after OUR successful kill.
      try {
        unlinkSync(join(tmuxSocketDir(), session.socketName));
      } catch {
        // Already gone or permission — the sweep converges later.
      }
    }
  }
  releaseOwnerLock(sessionLockPath(session.spoolDir), session.ownerNonce);
};

/** S4 owner-dead test for a spool dir (shared with future --continue/adopt/reaper paths). */
export const isSpoolOwnerDead = (spoolDir: string, staleAfterMs: number): boolean => {
  const owner = readOwner(sessionLockPath(spoolDir));
  if (!owner) return true;
  // isOwnerDead needs the lock dir; reuse it directly.
  return isOwnerDead(sessionLockPath(spoolDir), owner, staleAfterMs);
};

export const readDeathRecord = (spoolDir: string) => readJsonFile(deathJsonPath(spoolDir));
