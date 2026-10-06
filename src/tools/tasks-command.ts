import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ResolvedOptions } from "../config";
import { formatDurationSeconds } from "../render";
import { readTailLines } from "../engine/log-tail";
import { scanOrphanDirs } from "../engine/orphans";
import { listTasks, killTask } from "../engine/wiring";
import {
  resolveTaskRef,
  updateBackgroundProcessStatus,
  updateStoredBackgroundProcessStatus,
} from "../runtime";
import type { BackgroundJob, ExtensionState } from "../engine/types";
import { TasksOverlay, type OverlayJobRow } from "./tasks-overlay";

const jobLabel = (job: BackgroundJob): string => {
  const age = formatDurationSeconds(Date.now() - job.startedAt);
  const name = job.name ? `${job.name} · ` : "";
  return `${job.jobId} · ${name}$ ${job.command.slice(0, 60)} · ${age}`;
};

export const registerTasksCommand = (
  pi: ExtensionAPI,
  state: ExtensionState,
  options: ResolvedOptions,
): void => {
  const handler = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    const ref = args.trim();
    const ownPiId = ctx.sessionManager.getSessionId();
    const jobs = [...state.backgroundJobs.values()].sort((a, b) => a.startedAt - b.startedAt);
    // S5 surfacing: foreign completions stay silent until adopted — say so.
    const foreignPending = state.engine
      ? scanOrphanDirs(join(options.outputDir, "sessions"), ownPiId, options.ownerStaleAfterMs).reduce(
          (n, row) => n + row.running + row.pendingCompleted,
          0,
        )
      : 0;
    const orphanPointer =
      foreignPending > 0
        ? ` (${foreignPending} job(s) in other sessions — see /orphans)`
        : "";

    const killRef = async (target: string): Promise<void> => {
      const confirmed = await ctx.ui.confirm(
        "Kill background job?",
        `${target}\n\nThe tmux window is terminated immediately.`,
      );
      if (!confirmed) return;
      const jobRef = resolveTaskRef(state, options, target);
      if (!jobRef?.engine) {
        ctx.ui.notify(`Unknown background job: ${target}${orphanPointer}`, "error");
        return;
      }
      const ok = killTask(state, options, jobRef.jobId);
      if (ok) updateBackgroundProcessStatus(ctx, state, options);
      ctx.ui.notify(
        ok ? `Killed background tmux window: ${jobRef.windowId}.` : `Unknown background job: ${target}`,
        ok ? "info" : "error",
      );
    };

    // Direct form: /tasks <job_id>[@window] kills after confirmation.
    if (ref) {
      const known = state.backgroundJobs.has(ref) || /^@\d+$/.test(ref);
      if (!known) {
        ctx.ui.notify(`Unknown background job: ${ref}${orphanPointer}`, "error");
        return;
      }
      await killRef(ref);
      return;
    }

    if (ctx.hasUI === false) {
      if (jobs.length === 0) {
        ctx.ui.notify(`No background shell jobs.${orphanPointer}`, "info");
        return;
      }
      ctx.ui.notify(jobs.map(jobLabel).join("\n"), "info");
      return;
    }

    // Nested overlay browser: list stays empty-safe, detail peeks live logs,
    // double-K kills in place. Nothing dumps into the transcript.
    const getRows = (): OverlayJobRow[] =>
      state.engine
        ? listTasks(state).map((row) => ({
            jobId: row.jobId,
            windowId: row.windowId,
            name: row.name,
            command: row.command,
            status: row.status,
            unread: row.unread,
            logFile: row.logFile,
            startedAt: row.startedAt,
          }))
        : [];
    await ctx.ui.custom<void>((tui, theme, _kb, done) => {
      const overlay = new TasksOverlay(
        tui,
        theme,
        {
          getRows,
          getLogTail: (jobId, maxLines) => {
            const row = getRows().find((r) => r.jobId === jobId);
            return row ? readTailLines(row.logFile, maxLines) : "";
          },
          onKill: (jobId) => {
            const ok = killTask(state, options, jobId);
            if (ok) updateStoredBackgroundProcessStatus(state, options);
            return ok;
          },
          orphanPointer,
        },
        done,
      );
      return overlay;
    }, { overlay: true, overlayOptions: { anchor: "center", width: 74, maxHeight: 26 } });
  };

  for (const name of ["tasks", "bashes"] as const) {
    pi.registerCommand(name, {
      description:
        name === "tasks"
          ? "Browse background shell jobs (live logs, kill in place; /tasks <job_id> kills directly)"
          : "Alias for /tasks",
      handler,
    });
  }
};
