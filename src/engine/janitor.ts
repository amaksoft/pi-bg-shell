import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ResolvedOptions } from "../config";
import type { ExtensionState } from "./types";
import { releaseAdoptedDirs, restoreAdoptedDirs } from "./orphans";
import { defaultReaperProbes, pruneSpool, runReaper, sweepDeadSockets, sweepTmpFiles } from "./reaper";
import { destroySession } from "./session";

/**
 * Startup/shutdown janitor: all one-shot engine housekeeping in one place.
 * The tick owns live jobs; the janitor owns everything else (adopt, reap,
 * prune, sweep, drain, destroy). Every step is best-effort — a janitor
 * failure must never break startup or shutdown.
 */
export const janitorStart = (
  pi: ExtensionAPI,
  state: ExtensionState,
  options: ResolvedOptions,
): void => {
  const spoolRoot = join(options.outputDir, "sessions");
  // Re-adopt foreign dirs from a previous session before the reaper runs:
  // our live lock protects them from being reaped as orphans.
  try {
    restoreAdoptedDirs(pi, state, options);
  } catch {
    // Best-effort; /orphans lists anything left behind.
  }
  // Dead non-leave-running sessions (own + foreign dirs), retention prune,
  // crash-window tmp sweep, and orphaned socket files (triple-gated,
  // best-effort).
  try {
    runReaper(spoolRoot, options.ownerStaleAfterMs, defaultReaperProbes(options.tmuxBinary));
    pruneSpool(spoolRoot, options.preservedOutputRetentionDays, options.maxPreservedOutputMb);
    sweepTmpFiles(spoolRoot);
    sweepDeadSockets(options.tmuxBinary);
  } catch {
    // Best-effort; lazy reaper-on-next-start covers nobody-home.
  }
};

/** Shutdown teardown: release adopted dirs, stop the tick, destroy the server. */
/**
 * Shutdown order is load-bearing: stop the tick FIRST (no new consumes
 * after this point), destroy our server, release adopted locks LAST (a
 * foreign reaper must never see our dirs lock-free mid-flush).
 */
export const janitorStop = (state: ExtensionState, leaveRunning: boolean): void => {
  const engine = state.engine;
  try {
    engine?.reconciler?.stop();
  } catch {
    // Best-effort; shutdown delivery may already be gone.
  }
  if (engine?.session && engine?.runner) {
    try {
      destroySession(engine.session, engine.runner, leaveRunning);
    } catch {
      // Shutdown cleanup is best-effort; reaper-on-next-start owns leftovers.
    }
  }
  try {
    releaseAdoptedDirs(state);
  } catch {
    // Best-effort; foreign locks age out via the reaper.
  }
  state.engine = null;
};
