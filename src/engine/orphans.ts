import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ResolvedOptions } from "../config";
import type { ExtensionState } from "./types";
import { deliverCompletions, syncJobToState } from "./wiring";
import { acquireOwnerLock, isOwnerDead, readOwner, releaseOwnerLock } from "./owner-lock";
import { atomicWriteJson, readJsonFile, type JobRecord, type SessionRecord } from "./sidecar";
import { jobJsonPath, jobsDir, sessionJsonPath, sessionLockPath } from "./naming";
import type { Session } from "./session";

/**
 * Orphan controls: /orphans surfaces lingering foreign sessions; adopt takes
 * fenced ownership (completed rows report once with original jobIds, running
 * rows join the shared tick — one loop per process, previous owner dead).
 * Tombstoned dirs settle was-running rows as plain killed (log retained,
 * exit unknown): visible in /orphans, never a fabricated completion.
 */

export interface OrphanRow {
  piId: string;
  spoolDir: string;
  sessionName: string;
  leaveRunning: boolean;
  ownerDead: boolean;
  running: number;
  pendingCompleted: number;
  tombstoned: boolean;
}

/** List foreign engine sessions (own pi id excluded; other namespaces ignored). */
export const scanOrphanDirs = (
  spoolRoot: string,
  ownPiId: string,
  staleAfterMs: number,
): OrphanRow[] => {
  let dirs: string[];
  try {
    dirs = readdirSync(spoolRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(spoolRoot, entry.name));
  } catch {
    return [];
  }
  const rows: OrphanRow[] = [];
  for (const spoolDir of dirs) {
    const record = readJsonFile<SessionRecord>(sessionJsonPath(spoolDir));
    if (!record || record.version !== 1 || record.piId === ownPiId) continue;
    const lockDir = sessionLockPath(spoolDir);
    const owner = readOwner(lockDir);
    const ownerDead = !owner || isOwnerDead(lockDir, owner, staleAfterMs);
    let running = 0;
    let pendingCompleted = 0;
    try {
      for (const file of readdirSync(jobsDir(spoolDir))) {
        if (!file.endsWith(".json")) continue;
        const job = readJsonFile<JobRecord>(join(jobsDir(spoolDir), file));
        if (!job || job.status !== "running") continue;
        if (existsSync(job.exitFile) || existsSync(`${job.exitFile}.consumed`)) pendingCompleted += 1;
        else running += 1;
      }
    } catch {
      // Unreadable jobs dir: counts stay zero, row still listed.
    }
    rows.push({
      piId: record.piId,
      spoolDir,
      sessionName: record.sessionName,
      leaveRunning: record.shutdownPolicy === "leave-running",
      ownerDead,
      running,
      pendingCompleted,
      tombstoned: existsSync(join(spoolDir, "death.json")),
    });
  }
  return rows.sort((a, b) => a.piId.localeCompare(b.piId));
};

export interface AdoptResult {
  adopted: boolean;
  deliveredCompleted: string[];
  salvagedRunning: string[];
  stillRunning: string[];
  error?: string;
}

/**
 * Adopt a foreign dir: owner-dead gate, lock takeover, tombstone salvage,
 * then watch with our own reconciler (per-dir single writer preserved).
 * Completions deliver through our pi with ORIGINAL jobIds, exactly once.
 */
export const adoptOrphanDir = (
  pi: ExtensionAPI,
  state: ExtensionState,
  options: ResolvedOptions,
  spoolDir: string,
): AdoptResult => {
  const owned = state.engine;
  const result: AdoptResult = { adopted: false, deliveredCompleted: [], salvagedRunning: [], stillRunning: [] };
  if (!owned) {
    result.error = "engine not active";
    return result;
  }
  // Adopted dirs are watched on the shared tick: without a reconciler
  // their jobs would never complete. Fail closed (production always has
  // one; only hand-built states lack it).
  if (!owned.reconciler) {
    result.error = "engine reconciler unavailable";
    return result;
  }
  const record = readJsonFile<SessionRecord>(sessionJsonPath(spoolDir));
  if (!record || record.version !== 1) {
    result.error = "not a engine session dir";
    return result;
  }
  // Owner-dead gate: never steal from a live owner.
  const lockDir = sessionLockPath(spoolDir);
  const acquired = acquireOwnerLock(lockDir, options.ownerStaleAfterMs);
  if (acquired.outcome === "live") {
    result.error = "owner still alive; adoption refused";
    return result;
  }
  // Epoch bump: marks our takeover generation in the sidecar. A previous
  // owner that was actually stalled (not dead) sees the move on its next
  // tick and stops reconciling instead of double-driving the dir.
  const epoch = (record.epoch ?? 0) + 1;
  try {
    atomicWriteJson(sessionJsonPath(spoolDir), { ...record, epoch });
  } catch {
    releaseOwnerLock(lockDir, acquired.owner.nonce);
    result.error = "could not record takeover";
    return result;
  }
  const foreign: Session = {
    piId: record.piId,
    spoolDir,
    sessionName: record.sessionName,
    socketName: socketFromRecord(record) ?? "",
    sessionGuid: record.sessionGuid,
    ownerNonce: acquired.owner.nonce,
    epoch,
  };
  if (!foreign.socketName) {
    releaseOwnerLock(lockDir, acquired.owner.nonce);
    result.error = "no socket in sidecar";
    return result;
  }

  // Tombstoned dir: was-running rows can never resume (their windows died
  // with the reaped server). Settle them as plain killed rows — log
  // retained, exit unknown — visible in /orphans, never a fabricated
  // completion report.
  const death = readJsonFile<{ reason?: string }>(join(spoolDir, "death.json"));
  if (death) {
    for (const jobId of pendingJobIds(spoolDir)) {
      const job = readJsonFile<JobRecord>(jobJsonPath(spoolDir, jobId));
      if (!job || job.status !== "running") continue;
      if (existsSync(job.exitFile) || existsSync(`${job.exitFile}.consumed`)) continue; // tick will consume
      job.status = "killed";
      atomicWriteJson(jobJsonPath(spoolDir, jobId), job);
      result.salvagedRunning.push(jobId);
    }
  }

  // Sync rows BEFORE the first kick so delivery carries job identity.
  // Adopted rows are background by nature (their owner is dead).
  for (const jobId of pendingJobIds(spoolDir)) syncJobToState(state, foreign, jobId, true);
  // One-shot: deliver already-completed rows immediately, exactly once,
  // through the shared delivery path; count them as delivered.
  const ready = owned.reconciler.consumeReady(foreign, pendingJobIds(spoolDir));
  if (ready.length > 0) {
    deliverCompletions(pi, state, options, ready);
    for (const item of ready) result.deliveredCompleted.push(item.job.jobId);
  }
  // Watch on the shared tick from here on (polls, stalls, completions flow
  // through the main callbacks, including stall warnings adopted rows gain).
  owned.reconciler.watch(spoolDir, foreign, acquired.owner.nonce);
  owned.reconciler.kick();
  if (!owned.adopted) owned.adopted = new Map();
  owned.adopted.set(spoolDir, { session: foreign, ownerNonce: acquired.owner.nonce });
  for (const jobId of pendingJobIds(spoolDir)) {
    const job = readJsonFile<JobRecord>(jobJsonPath(spoolDir, jobId));
    if (job?.status === "running") result.stillRunning.push(jobId);
  }
  persistAdoptedDir(owned.session.spoolDir, spoolDir);
  state.engine?.widget?.poke();
  result.adopted = true;
  return result;
};

/** Unwatch adopted dirs + release foreign locks (shutdown path). */
export const releaseAdoptedDirs = (state: ExtensionState): void => {
  const adopted = state.engine?.adopted;
  if (!adopted) return;
  for (const [spoolDir, entry] of adopted) {
    try {
      state.engine?.reconciler?.unwatch(spoolDir);
    } catch {
      // Best-effort.
    }
    try {
      releaseOwnerLock(sessionLockPath(spoolDir), entry.ownerNonce);
    } catch {
      // Best-effort.
    }
  }
  adopted.clear();
};

const pendingJobIds = (spoolDir: string): string[] => {
  try {
    return readdirSync(jobsDir(spoolDir))
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -".json".length));
  } catch {
    return [];
  }
};

const socketFromRecord = (record: SessionRecord): string | undefined => {
  const match = /^-L\s+(\S+)/.exec(record.tmuxServer ?? "");
  return match?.[1];
};

/** Remember adoption in our own sidecar (restored on restart). */
const persistAdoptedDir = (ownSpoolDir: string, adoptedDir: string): void => {
  const path = sessionJsonPath(ownSpoolDir);
  const record = readJsonFile<SessionRecord>(path);
  if (!record) return;
  const adoptedDirs = record.adoptedDirs ?? [];
  if (!adoptedDirs.includes(adoptedDir)) adoptedDirs.push(adoptedDir);
  atomicWriteJson(path, { ...record, adoptedDirs });
};

export interface AdoptRestoreResult {
  restored: string[];
  skipped: { spoolDir: string; reason: string }[];
}

/**
 * Re-adopt foreign dirs remembered in our own sidecar. Each attempt runs
 * the full owner-dead gate inside adoptOrphanDir, so a dir adopted elsewhere
 * (or gone) is skipped, never stolen. Best-effort per dir.
 */
export const restoreAdoptedDirs = (
  pi: ExtensionAPI,
  state: ExtensionState,
  options: ResolvedOptions,
): AdoptRestoreResult => {
  const result: AdoptRestoreResult = { restored: [], skipped: [] };
  const owned = state.engine;
  if (!owned) return result;
  const record = readJsonFile<SessionRecord>(sessionJsonPath(owned.session.spoolDir));
  for (const spoolDir of record?.adoptedDirs ?? []) {
    if (owned.adopted?.has(spoolDir)) continue;
    try {
      const adopted = adoptOrphanDir(pi, state, options, spoolDir);
      if (adopted.adopted) result.restored.push(spoolDir);
      else result.skipped.push({ spoolDir, reason: adopted.error ?? "unknown" });
    } catch (error) {
      result.skipped.push({
        spoolDir,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
};
