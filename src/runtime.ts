import {
  type AgentToolUpdateCallback,
  type BashToolDetails,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { execSafe, shellQuote, tmuxWindowAttachHint, type TmuxWindow } from "./tmux-utils";
import { BACKGROUND_BASH_STATUS_KEY, type ResolvedOptions } from "./config";
import type { BashInput, TmuxInput } from "./tool-call-schemas";
import type { JobsWidget } from "./tools/jobs-widget";
import { killTask, listTasks, peekTask } from "./engine/wiring";
import { JOB_ID_OPTION } from "./engine/jobs";
import type { Reconciler } from "./engine/reconciler";
import type { Runner, Session } from "./engine/session";
import {
  displayCommandForCommand,
  formatCompletionSummary,
  formatRenderedBashResult,
  indentDisplayLine,
  indentDisplayLines,
  type FormattedOutput,
  type PollMessageRenderDetails,
} from "./render";
import { resolveDisplayName } from "./engine/grammar";
import { textRowLabel, formatAge } from "./engine/grammar";
import type { BackgroundJob, ExtensionState, ForegroundRun, TmuxReadiness } from "./engine/types";

type TmuxRenderDetails = {
  summary: string;
  expandedLines: string[];
  collapsedLines: string[];
  attachLines?: string[];
};
// Exit-code files report completion; the .out sibling keeps exact output for truncation and UI replay.
export const createState = (): ExtensionState => ({
  statusContext: null,
  backgroundJobs: new Map(),
  foregroundRuns: new Map(),
  detachRequested: new Set(),
  tmuxReady: null,
  engine: null,
});

/** First pipeline word of the display command (binary basename), for templates. */
const commandLabel = (cmd: string, name: string | undefined, options: ResolvedOptions): string => {
  if (name) return name;
  const shown = displayCommandForCommand(cmd, options.displayCommandStartMarker);
  const firstWord = shown.split(/[|;&\s]/)[0];
  return firstWord?.split("/").pop() || "shell";
};

const fillVariable = (template: string, variable: string, value: string): string =>
  template.replace(new RegExp(`{{\\s*${variable}\\s*}}`, "g"), value);

/** Window display name with pipes removed (they break |||-joined tmux listings). */
export const tmuxWindowNameForCommand = (
  cmd: string,
  name: string | undefined,
  options: ResolvedOptions,
): string => {
  const shown = displayCommandForCommand(cmd, options.displayCommandStartMarker);
  const filled = Object.entries({
    command: shown,
    name: name ?? "",
    nameOrCommand: commandLabel(cmd, name, options),
  }).reduce(
    (text, [variable, value]) => fillVariable(text, variable, value),
    options.tmuxWindowNameTemplate,
  );
  return filled.replace(/\|/g, " ").slice(0, options.maxTmuxWindowNameLength);
};

export const bashUpdate = (text = "", details?: BashToolDetails) => ({
  content: text ? [{ type: "text" as const, text }] : [],
  details,
});

/**
 * Detach ALL in-flight foreground runs (Ctrl+B backgrounds everything, not
 * just the most recent — ambiguous multi-run states resolve by demoting
 * every waiter; each wait loop observes its own flag).
 */
export const requestDetach = (
  state: ExtensionState,
): { toolCallId: string; run: ForegroundRun }[] => {
  const detached: { toolCallId: string; run: ForegroundRun }[] = [];
  for (const [toolCallId, run] of state.foregroundRuns.entries()) {
    state.detachRequested.add(toolCallId);
    detached.push({ toolCallId, run });
  }
  return detached;
};


const shortJobLabel = (job: BackgroundJob, now: number): string => {
  const base = resolveDisplayName(job.command, job.name).trim() || "shell";
  const name = base.length > 24 ? `${base.slice(0, 23)}…` : base;
  // Job id included: without it the footer names work you cannot act on.
  return `${name} · ${job.jobId} · ${formatAge(now - job.startedAt)}`;
};

export const formatBackgroundProcessStatus = (jobs: BackgroundJob[]): string | undefined => {
  if (jobs.length === 0) return undefined;
  // Keep the `N background proc(s)` prefix: downstreams parse it (contract).
  const now = Date.now();
  const shown = jobs.slice(0, 3).map((job) => shortJobLabel(job, now)).join(", ");
  const rest = jobs.length > 3 ? ` +${jobs.length - 3} more` : "";
  const text = `${jobs.length} background proc${jobs.length === 1 ? "" : "s"}: ${shown}${rest}`;
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
};

export const updateBackgroundProcessStatus = (
  ctx: ExtensionContext,
  state: ExtensionState,
  options: ResolvedOptions,
): void => {
  if (!ctx.hasUI) return;
  const jobs = [...state.backgroundJobs.values()].sort((a, b) => a.startedAt - b.startedAt);
  ctx.ui.setStatus(BACKGROUND_BASH_STATUS_KEY, formatBackgroundProcessStatus(jobs));
};

export const updateStoredBackgroundProcessStatus = (
  state: ExtensionState,
  options: ResolvedOptions,
): void => {
  if (!state.statusContext) return;
  try {
    updateBackgroundProcessStatus(state.statusContext, state, options);
  } catch (error) {
    // Status is ambient chrome; log and continue, never break delivery.
    console.debug(`[pi-bg-shell] status update failed: ${error}`);
  }
};

type CustomMessageInput = Parameters<ExtensionAPI["sendMessage"]>[0];

const pollDetails = (
  window: TmuxWindow,
  output: FormattedOutput,
  options: ResolvedOptions,
  socketName?: string,
): PollMessageRenderDetails => ({
  summary: `tmux poll: ${window.title} ${window.id}`,
  command: `$ ${window.displayCommand ?? window.title}`,
  output: output.details.render,
  attachLines: [
    indentDisplayLine(tmuxWindowAttachHint(window.id, process.env, options.tmuxBinary, socketName)),
  ],
});

export const pollCustomMessage = (
  window: TmuxWindow,
  output: FormattedOutput,
  options: ResolvedOptions,
  socketName?: string,
): CustomMessageInput => {
  const details = pollDetails(window, output, options, socketName);
  return {
    customType: "tmux-bash-poll",
    content: [
      details.summary,
      indentDisplayLine(details.command),
      ...indentDisplayLines(formatRenderedBashResult(details.output, { expanded: true }).split("\n")),
      "",
      ...details.attachLines,
    ].join("\n"),
    details,
    display: true,
  };
};

/** Bell-equivalent: toast on completion (transcript turn carries the details). */
export const notifyCompletion = (
  state: ExtensionState,
  options: ResolvedOptions,
  exitCode: number,
  command?: string,
): void => {
  if (!options.notifyOnCompletion) return;
  try {
    const label = command
      ? `${formatCompletionSummary(exitCode)}: ${command.slice(0, 80)}`
      : formatCompletionSummary(exitCode);
    state.statusContext?.ui.notify(label, exitCode === 0 ? "info" : "error");
  } catch {
    // Notifications must never break completion delivery.
  }
};


export const effectivePollInterval = (interval: number, options: ResolvedOptions): number =>
  options.pollDelivery === "model"
    ? Math.max(interval, options.minimumPollIntervalSeconds)
    : interval;

// Display-only polls wait for an idle UI so they don't interrupt the user's active turn.
/** Max idle-wait retries before a display poll sends anyway (stale beats lost). */
const MAX_IDLE_RETRIES = 20;

export const sendPollMessageWhenIdle = (
  pi: ExtensionAPI,
  state: ExtensionState,
  message: CustomMessageInput,
  retriesLeft: number = MAX_IDLE_RETRIES,
): void => {
  let idle = true;
  try {
    idle = state.statusContext?.isIdle?.() !== false;
  } catch {
    // A stale context must never break poll delivery; fall through to send.
  }
  if (idle || retriesLeft <= 0) {
    pi.sendMessage(message, { triggerTurn: false });
    return;
  }
  setTimeout(() => {
    sendPollMessageWhenIdle(pi, state, message, retriesLeft - 1);
  }, 100);
};

const toolText = (text: string, details: Record<string, unknown> = {}) => ({
  content: [{ type: "text" as const, text }],
  details,
});

const renderedToolText = (
  text: string,
  render: TmuxRenderDetails,
  details: Record<string, unknown> = {},
) => toolText(text, { ...details, render });

const summaryToolText = (summary: string, details: Record<string, unknown> = {}) =>
  renderedToolText(summary, { summary, expandedLines: [], collapsedLines: [] }, details);

export const toolError = (text: string) => ({
  ...summaryToolText(text),
  isError: true as const,
});

export const checkTmuxReadiness = (options: ResolvedOptions): TmuxReadiness => {
  if (process.platform === "win32") {
    return { ok: false, error: "Error: bg-shell needs Unix with tmux; Windows is not supported." };
  }
  const raw = execSafe(`${shellQuote(options.tmuxBinary)} -V 2>/dev/null`);
  const match = /tmux (\d+)\.(\d+)/.exec(raw ?? "");
  if (!match) {
    return {
      ok: false,
      error: `Error: tmux not found at '${options.tmuxBinary}'. Install tmux >= 3.0 and ensure it is on PATH.`,
    };
  }
  if (Number.parseInt(match[1], 10) < 3) {
    return {
      ok: false,
      error: `Error: tmux >= 3.0 is required (found ${match[1]}.${match[2]}).`,
    };
  }
  return { ok: true, version: `${match[1]}.${match[2]}` };
};

/** Cached readiness gate: null when usable, otherwise the model-readable error. */
export const requireTmux = (state: ExtensionState, options: ResolvedOptions): string | null => {
  if (!state.tmuxReady) state.tmuxReady = checkTmuxReadiness(options);
  return state.tmuxReady.ok ? null : state.tmuxReady.error;
};

/**
 * Find an engine job by job_id only (undefined when unknown). Window ids
 * NEVER match here: tmux recycles them, so `@id` refs resolve against live
 * tmux truth via resolveWindowJob below, never the registry.
 */
export const resolveJobRef = (state: ExtensionState, ref: string): BackgroundJob | undefined => {
  for (const job of state.backgroundJobs.values()) {
    if (!job.engine) continue;
    if (job.jobId === ref) return job;
  }
  return undefined;
};

/**
 * Translate a live tmux window id (@N) to its job by reading the
 * `@pi_job_id` tag off live windows (own server first, then adopted).
 * Recycled ids resolve against tmux truth, not stale registry rows.
 * Returns undefined when no live window carries the id.
 */
export const resolveWindowJob = (
  state: ExtensionState,
  options: ResolvedOptions,
  windowId: string,
): BackgroundJob | undefined => {
  const engine = state.engine;
  if (!engine) return undefined;
  const sockets = [
    engine.session.socketName,
    ...[...(engine.adopted?.values() ?? [])].map((entry) => entry.session.socketName),
  ];
  for (const socket of sockets) {
    const raw = execSafe(
      `${shellQuote(options.tmuxBinary)} -L ${shellQuote(socket)} list-windows -F ${shellQuote(`#{window_id} #{${JOB_ID_OPTION}}`)}`,
    );
    if (!raw) continue;
    for (const line of raw.split("\n")) {
      const [id, jobId] = line.trim().split(/\s+/);
      if (id === windowId && jobId) return resolveJobRef(state, jobId);
    }
  }
  return undefined;
};

/** Resolve a peek/kill ref: job_ids hit the registry, @ids hit live tmux. */
export const resolveTaskRef = (
  state: ExtensionState,
  options: ResolvedOptions,
  ref: string,
): BackgroundJob | undefined => {
  if (ref.startsWith("@")) return resolveWindowJob(state, options, ref);
  // Job ids mint lowercase; accept uppercase input by normalizing.
  const normalized = /^[0-9A-Fa-f]{6}$/.test(ref) ? ref.toLowerCase() : ref;
  return resolveJobRef(state, normalized);
};

const unknownJob = (ref: string) => toolError(`Unknown background job: ${ref}`);

const peekAction = (
  params: Extract<TmuxInput, { action: "peek" }>,
  state: ExtensionState,
  options: ResolvedOptions,
) => {
  const job = resolveTaskRef(state, options, params.window);
  if (!job?.engine) return unknownJob(params.window);
  const text = peekTask(state, job.jobId, options.peekContextLines);
  if (text === undefined) return unknownJob(params.window);
  return renderedToolText(
    text,
    { summary: text.split("\n")[0], expandedLines: [text], collapsedLines: [text] },
    { session: job.session },
  );
};

const listAction = (state: ExtensionState) => {
  if (state.engine) {
    const rows = listTasks(state);
    const lines = rows.map((row) =>
      textRowLabel(row.command, row.windowId, { unread: row.unread }),
    );
    const summary = `Background session ${state.engine.session.sessionName} — ${rows.length} window(s)`;
    return renderedToolText(
      `${summary}\n\n${lines.join("\n")}`,
      { summary, expandedLines: ["", ...lines], collapsedLines: ["", ...lines] },
      { session: state.engine.session.sessionName, windows: [] },
    );
  }
  return toolError("No background session. Start a new bash command to create one.");
};

const killAction = (
  params: Extract<TmuxInput, { action: "kill" }>,
  state: ExtensionState,
  options: ResolvedOptions,
) => {
  const job = resolveTaskRef(state, options, params.window);
  if (!job?.engine) return unknownJob(params.window);
  if (!killTask(state, options, job.jobId)) return unknownJob(params.window);
  return summaryToolText(
    `Killed background tmux window: ${job.command.split("\n")[0].slice(0, 60)} ${job.windowId}.`,
  );
};

export const executeTool = (
  params: TmuxInput,
  ctx: ExtensionContext,
  state: ExtensionState,
  pi: ExtensionAPI,
  options: ResolvedOptions,
) => {
  const tmuxError = requireTmux(state, options);
  if (tmuxError) return toolError(tmuxError);
  if (params.action === "peek") return peekAction(params, state, options);
  if (params.action === "list") return listAction(state);
  if (params.action === "kill") {
    const result = killAction(params, state, options);
    updateBackgroundProcessStatus(ctx, state, options);
    return result;
  }
  // Unreachable via schema (poll/unpoll/list-polls retired): defensive net
  // for stale callers. Interim output arrives automatically from the tick.
  return toolError(
    "Standalone polling is retired: interim output arrives automatically while the job runs.",
  );
};

export const bashPollInterval = (params: BashInput): number =>
  "pollInterval" in params ? (params.pollInterval ?? 0) : 0;
