import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ResolvedOptions } from "../config";
import { updateBackgroundProcessStatus } from "../runtime";
import type { ExtensionState } from "../engine/types";
import { runReaper, defaultReaperProbes } from "../engine/reaper";
import { adoptOrphanDir, scanOrphanDirs, type OrphanRow } from "../engine/orphans";

const orphanLabel = (row: OrphanRow): string => {
  const bits = [
    row.piId,
    row.tombstoned ? "reaped" : row.leaveRunning ? "leave-running" : "active",
    row.ownerDead ? "owner dead" : "owner LIVE",
    `${row.running} running`,
    `${row.pendingCompleted} done`,
  ];
  return bits.join(" · ");
};

/** /orphans: surface lingering foreign engine sessions; adopt or reap them. No auto-adopt, no auto-kill of survivors. */
export const registerOrphansCommand = (
  pi: ExtensionAPI,
  state: ExtensionState,
  options: ResolvedOptions,
): void => {
  const handler = async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
    const owned = state.engine;
    if (!owned) {
      ctx.ui.notify("Background engine is not running this session — start a bash command first.", "error");
      return;
    }
    const spoolRoot = join(options.outputDir, "sessions");
    const ownPiId = ctx.sessionManager.getSessionId();
    const rows = scanOrphanDirs(spoolRoot, ownPiId, options.ownerStaleAfterMs);
    if (rows.length === 0) {
      ctx.ui.notify("No orphaned sessions.", "info");
      return;
    }
    if (ctx.hasUI === false) {
      ctx.ui.notify(rows.map(orphanLabel).join("\n"), "info");
      return;
    }
    const selected = await ctx.ui.select("Orphaned sessions", rows.map(orphanLabel));
    if (!selected) return;
    const piId = selected.split(" · ")[0];
    const row = rows.find((r) => r.piId === piId);
    if (!row) return;
    const actions = ["Adopt (report completions once, watch running)"];
    if (row.ownerDead && !row.leaveRunning) actions.push("Reap now");
    actions.push("← Back");
    const action = await ctx.ui.select(`Orphan ${piId}`, actions);
    if (action === undefined || action === "← Back") return;
    if (action === "Reap now") {
      const result = runReaper(spoolRoot, options.ownerStaleAfterMs, defaultReaperProbes(options.tmuxBinary));
      const reaped = result.reaped.some((r) => r.spoolDir === row.spoolDir);
      ctx.ui.notify(reaped ? `Reaped orphaned session ${piId}.` : `Could not reap ${piId} (still live or already gone).`, reaped ? "info" : "error");
      return;
    }
    const adopted = adoptOrphanDir(pi, state, options, row.spoolDir);
    if (!adopted.adopted) {
      ctx.ui.notify(`Could not adopt ${piId}: ${adopted.error ?? "unknown error"}.`, "error");
      return;
    }
    updateBackgroundProcessStatus(ctx, state, options);
    const parts = [`Adopted ${piId}: ${adopted.deliveredCompleted.length} completed, ${adopted.salvagedRunning.length} salvaged, ${adopted.stillRunning.length} still running.`];
    ctx.ui.notify(parts.join(" "), "info");
  };

  pi.registerCommand("orphans", {
    description: "List orphaned background sessions from other pi sessions (adopt or reap them)",
    handler,
  });
};
