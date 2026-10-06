import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { version as engineVersion } from "../package.json";
import { BACKGROUND_BASH_STATUS_KEY, resolveOptions, type TmuxBashOptions } from "./config";
import {
  checkTmuxReadiness,
  createState,
  requestDetach,
  updateBackgroundProcessStatus,
} from "./runtime";
import { registerMessageRenderers } from "./renderers/messages";
import { JobsWidget } from "./tools/jobs-widget";
import { registerOrphansCommand } from "./tools/orphans-command";
import { deliverCompletions, deliverPoll, deliverStall } from "./engine/wiring";
import { janitorStart, janitorStop } from "./engine/janitor";
import { defaultReaperProbes, pruneSpool, runReaper, sweepDeadSockets } from "./engine/reaper";

/** Slow maintenance cadence: GC debris converges without restart spam. */
const SLOW_TICK_MS = 300000;
import { shutdownWarningText } from "./engine/report";
import { Reconciler } from "./engine/reconciler";
import { ensureSession } from "./engine/session";
import { registerBashTool } from "./tools/bash-tool";
import { registerTasksCommand } from "./tools/tasks-command";
import { registerTmuxTool } from "./tools/tmux-tool";

export { DEFAULT_OPTIONS, TmuxBashOptionsSchema, type TmuxBashOptions } from "./config";

const DISABLE_VALUES = new Set(["1", "true", "yes"]);

/** Kill-switch: PI_BG_DISABLE=1/true/yes leaves the native bash tool untouched. */
export const isBackgroundShellDisabled = (): boolean =>
  DISABLE_VALUES.has((process.env.PI_BG_DISABLE ?? "").trim().toLowerCase());

export const tmuxBash = (input: TmuxBashOptions = {}) => {
  const options = resolveOptions(input);
  // Load marker: makes stale-extension-code instantly diagnosable.
  console.log(`[pi-bg-shell] engine v${engineVersion} loaded (Ctrl+B detach, job ids, orphan adoption).`);

  return (pi: ExtensionAPI): void => {
    // Kill-switch: leave the native bash tool completely untouched.
    if (isBackgroundShellDisabled()) {
      console.log("[pi-bg-shell] disabled via PI_BG_DISABLE; native bash stays active.");
      return;
    }
    const state = createState();
    const widget = options.jobsWidget === false ? null : new JobsWidget(state, options.jobsWidget);
    let reconciler: Reconciler | undefined;
    const runner = {
      tmux: (socketName: string, args: string[]): string =>
        execFileSync(options.tmuxBinary, ["-L", socketName, ...args], {
          // Capture, never display: tmux errors on dead sockets must not
          // pollute pi's terminal, but stay parseable in error.message.
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
        }),
    };
    const spoolRoot = join(options.outputDir, "sessions");

    pi.on("session_start", async (_event, ctx) => {
      state.tmuxReady = checkTmuxReadiness(options);
      const piId = ctx.sessionManager.getSessionId();
      state.statusContext = ctx;
      if (state.tmuxReady.ok) {
        try {
          const session = ensureSession({
            piId,
            spoolRoot,
            shutdownPolicy: options.shutdownPolicy,
            staleAfterMs: options.ownerStaleAfterMs,
            runner,
          });
          reconciler = new Reconciler(
            session,
            {
              onCompletions: (items) => {
                try {
                  deliverCompletions(pi, state, options, items);
                } catch (error) {
                  console.log(`[pi-bg-shell] delivery failed for ${items.length} job(s): ${error}`);
                }
              },
              onPoll: (job, newText) => {
                try {
                  deliverPoll(pi, state, options, job, newText);
                } catch {
                  // Interim polls are best-effort; never break the tick.
                }
              },
              onStall: (job, tail) => {
                try {
                  deliverStall(pi, state, options, job, tail);
                } catch {
                  // Stall warnings are best-effort; never break the tick.
                }
              },
              // Continuous GC: a long-running session converges socket
              // debris, retention backlog, and dead sessions without
              // waiting for the next restart. Same trio as janitorStart.
              onSlowTick: () => {
                try {
                  sweepDeadSockets(options.tmuxBinary);
                  pruneSpool(
                    spoolRoot,
                    options.preservedOutputRetentionDays,
                    options.maxPreservedOutputMb,
                  );
                  runReaper(
                    spoolRoot,
                    options.ownerStaleAfterMs,
                    defaultReaperProbes(options.tmuxBinary),
                  );
                } catch {
                  // Best-effort GC must never break the tick.
                }
              },
            },
            {
              tickMs: 1000,
              minimumPollIntervalSeconds: options.minimumPollIntervalSeconds,
              completionTailBytes: 8000,
              stallPromptThresholdMs: options.stallPromptThresholdSeconds * 1000,
              slowTickMs: SLOW_TICK_MS,
            },
            session.ownerNonce,
          );
          reconciler.start();
          state.engine = { session, runner, reconciler, widget };
          if (widget) {
            try {
              widget.attach(ctx.ui);
            } catch {
              // Presentation only: a widget failure must never break the session.
            }
          }
          // One-shot housekeeping (adopt, reap, prune, sweep).
          janitorStart(pi, state, options);
        } catch {
          // Fail open: without a session there is no engine (busy-owner or
          // tmux failure); tools report it via requireTmux/engine absence.
          console.log("[pi-bg-shell] engine unavailable; background jobs disabled this session.");
        }
      }
      updateBackgroundProcessStatus(ctx, state, options);
    });

    pi.on("turn_start", async () => {
      reconciler?.kick();
      // Age after the kick so this turn's completions show as fresh-finished.
      state.engine?.widget?.ageFinished();
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      try {
        if (widget) widget.detach(ctx.ui);
      } catch {
        // Best-effort; shutdown UI may already be gone.
      }
      // Engine teardown (release adopted, stop tick, destroy server).
      janitorStop(state, options.shutdownPolicy === "leave-running");
      reconciler = undefined;
      const doomed = options.shutdownPolicy === "stop-all" ? [...state.backgroundJobs.values()] : [];
      if (ctx.hasUI) {
        ctx.ui.setStatus(BACKGROUND_BASH_STATUS_KEY, undefined);
        const warning = shutdownWarningText(doomed);
        if (warning) {
          try {
            ctx.ui.notify(warning, "warning");
          } catch {
            // Shutdown UI may already be gone.
          }
        }
      }
    });

    registerBashTool(pi, state, options);
    if (options.tmuxEnabledActions.length > 0) registerTmuxTool(pi, state, options);
    registerMessageRenderers(pi, options);
    registerTasksCommand(pi, state, options);
    registerOrphansCommand(pi, state, options);

    // Claude-Code-style send-to-background. Best-effort under nested tmux
    // (ctrl+b is the tmux prefix there — press twice or rebind).
    // No contextual-shortcut API exists, so the key is claimed globally;
    // the handler is a silent no-op unless an engine-owned run is foregrounded.
    if (options.detachShortcut !== false) {
      pi.registerShortcut(options.detachShortcut as KeyId, {
        description: "Send the running shell command to the background",
        handler: async (ctx) => {
          const detached = requestDetach(state);
          if (detached.length === 0) return;
          const names = detached
            .map((entry) => entry.run.command.split("\n")[0].slice(0, 40))
            .slice(0, 3)
            .join(", ");
          const rest = detached.length > 3 ? ` (+${detached.length - 3} more)` : "";
          ctx.ui.notify(
            detached.length === 1
              ? `Backgrounded: ${names}`
              : `Backgrounded ${detached.length} commands: ${names}${rest}`,
          );
        },
      });
    }
  };
};
