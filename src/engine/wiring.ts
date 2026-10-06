import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import type {
  AgentToolUpdateCallback,
  BashToolDetails,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { ResolvedOptions } from "../config";
import {
  formatTmuxOutputForContext as formatOutput,
  type FormattedOutput,
  type TmuxBashToolDetails,
} from "../render";
import {
  bashPollInterval,
  bashUpdate,
  effectivePollInterval,
  notifyCompletion,
  pollCustomMessage,
  sendPollMessageWhenIdle,
  tmuxWindowNameForCommand,
  toolError,
  updateBackgroundProcessStatus,
  updateStoredBackgroundProcessStatus,
} from "../runtime";
import type { BackgroundJob, ExtensionState } from "./types";
import {
  buildBatchCompletion,
  buildLaunchText,
  buildTimeoutText,
  completionCustomMessage,
  timeoutBackgroundHint,
  type BatchBlock,
} from "./report";
import { resolveDisplayName } from "./grammar";
import type { BashInput } from "../tool-call-schemas";
import { getWindows } from "../tmux-utils";
import { readByteSlice, readTailLines } from "./log-tail";
import { consumeCompletion, killGuarded, markJobNotified, peekJob, spawnJob, waitJob } from "./jobs";
import { jobJsonPath } from "./naming";
import { atomicWriteJson, readJsonFile, type JobRecord } from "./sidecar";
import type { CompletionItem, JobSnapshot } from "./reconciler";
import { clearForegroundClaim, refreshForegroundClaim, setForegroundClaim } from "./jobs";
import type { Runner, Session } from "./session";
import type { WaitResult } from "./jobs";

/**
 * P1: engine tool wiring. Same user-visible texts as legacy (contract frozen);
 * ownership via the sidecar journal; presentation registry
 * (state.backgroundJobs) synced with a engine marker so footer//tasks-list work
 * unchanged, while peek/kill route to the engine by that marker.
 */

const engineOf = (state: ExtensionState) => state.engine;

export const syncJobToState = (
  state: ExtensionState,
  session: Session,
  jobId: string,
  backgrounded = false,
): void => {
  const record = readJsonFile<JobRecord>(jobJsonPath(session.spoolDir, jobId));
  if (!record) return;
  const existing = state.backgroundJobs.get(jobId);
  // Cross-dir jobId collision (6-hex, ~1e-10 at our scale): keep-first wins
  // so a lookup never silently retargets another live job; delivery does
  // not need the registry (snapshot + journal suffice).
  if (existing && existing.engine?.spoolDir !== session.spoolDir) {
    console.log(`[pi-bg-shell] jobId collision for ${jobId}; keeping first owner.`);
    return;
  }
  const job: BackgroundJob = {
    jobId,
    name: resolveDisplayName(record.command, record.name),
    backgrounded,
    session: session.sessionName,
    windowId: record.windowId,
    runId: jobId,
    outputFile: record.spoolLog,
    command: record.command,
    startedAt: existing?.startedAt ?? Date.now(),
    viaTimeoutDetach: existing?.viaTimeoutDetach ?? false,
    engine: { spoolDir: session.spoolDir },
  };
  state.backgroundJobs.set(jobId, job);
};

export const removeJobFromState = (state: ExtensionState, jobId: string): void => {
  state.backgroundJobs.delete(jobId);
};

const closeWindow = (state: ExtensionState, jobId: string, staleAfterMs: number): void => {
  const owned = engineOf(state);
  if (!owned) return;
  const record = readJsonFile<JobRecord>(jobJsonPath(owned.session.spoolDir, jobId));
  if (!record?.windowId) return;
  // Post-completion cleanup through the guarded path: the journal txn is a
  // no-op on finished rows, and the GUID predicate keeps recycled window
  // ids from catching an unrelated window.
  killGuarded(owned.session, owned.runner, { jobId, windowId: record.windowId }, staleAfterMs);
};

/**
 * Engine bash execution: mirrors runBashInTmux return texts exactly (foreground
 * result, Ctrl+B detach, timeout-demote, abort, background start) while
 * owning the job through the journal + foreground claim.
 */
type BegunRun = {
  job: { jobId: string; windowId: string; exitFile: string; logFile: string };
  windowName: string;
  displayName: string;
  followUpLine: string;
  pollSuffix: string;
  pollInterval: number;
  requestedPollInterval: number;
  wantsBackground: boolean;
};

type EngineOwned = { session: Session; runner: Runner };

/**
 * runBashJob phase 1 (launch): engine check, spawn, registry sync, status,
 * and the frozen follow-up texts. Returns the launch result directly for
 * background starts; foreground runs continue with the returned run.
 */
const beginJobRun = (
  input: BashInput,
  toolCallId: string,
  state: ExtensionState,
  options: ResolvedOptions,
  owned: EngineOwned,
  ctx: ExtensionContext,
): { ok: false; result: ReturnType<typeof toolError> } | { ok: true; run: BegunRun } => {
  state.statusContext = ctx;

  const windowName = tmuxWindowNameForCommand(input.command, input.name, options);
  // The journal keeps the given name (or nothing); display layers decide
  // between command-verbatim and derived labels via resolveDisplayName.
  // Grouped summaries ("ran <displayName>") read it from result details.
  const jobName = input.name;
  const displayName = resolveDisplayName(input.command, input.name);
  let job: { jobId: string; windowId: string; exitFile: string; logFile: string };
  try {
    job = spawnJob({
      session: owned.session,
      runner: owned.runner,
      tmuxBinary: options.tmuxBinary,
      command: input.command,
      name: jobName,
      cwd: process.cwd(),
      envDenylist: options.tmuxEnvExportDenylist,
      windowName,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return { ok: false as const, result: toolError(`Error: could not start tmux window (${detail}).`) };
  }
  const wantsBackground = input.background === true || input.run_in_background === true;
  // Foreground runs sync un-backgrounded (widget hides them); demote paths
  // flip the flag below. No tmux-name encoding needed — the registry owns it.
  syncJobToState(state, owned.session, job.jobId, wantsBackground);
  state.engine?.widget?.poke();
  updateBackgroundProcessStatus(ctx, state, options);
  const requestedPollInterval = bashPollInterval(input);
  const pollInterval = effectivePollInterval(requestedPollInterval, options);
  const pollSuffix = requestedPollInterval > 0 ? ` Polling every ${pollInterval}s.` : "";

  // Follow-up verb (CC parity): the model is told HOW to check back, not
  // just that a result will arrive. Appended, never replacing frozen lines.
  const followUpLine = `Follow up with /tasks ${job.jobId} or read ${job.logFile}.`;
  return {
    ok: true,
    run: {
      job,
      windowName,
      displayName,
      followUpLine,
      pollSuffix,
      pollInterval,
      requestedPollInterval,
      wantsBackground,
    },
  };
};

export const runBashJob = async (
  input: BashInput,
  toolCallId: string,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<BashToolDetails | undefined> | undefined,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: ExtensionState,
  options: ResolvedOptions,
) => {
  const owned = engineOf(state);
  if (!owned) return toolError("Error: engine session unavailable.");
  const begun = beginJobRun(input, toolCallId, state, options, owned, ctx);
  if (!begun.ok) return begun.result;
  const run = begun.run;
  if (run.wantsBackground) {
    return {
      content: [
        {
          type: "text" as const,
          text: buildLaunchText({
            windowName: run.windowName,
            windowId: run.job.windowId,
            jobId: run.job.jobId,
            logFile: run.job.logFile,
            pollSuffix: run.pollSuffix,
            followUpLine: run.followUpLine,
          }),
        },
      ],
      details: undefined,
    };
  }
  const foreground = await waitForeground(
    run,
    input,
    toolCallId,
    signal,
    onUpdate,
    state,
    options,
    owned,
  );
  return settleForegroundWait(run, input, foreground, state, options, owned, pi, ctx);
};

type ForegroundWait = {
  waited: WaitResult;
  output: FormattedOutput;
  text: string;
  releaseForegroundWait: () => void;
};


/**
 * runBashJob phase 2 (wait): claim the row, stream log slices, block on the
 * exit file. Returns the wait outcome plus a release for the claim/run maps.
 */
const waitForeground = async (
  run: BegunRun,
  input: BashInput,
  toolCallId: string,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<BashToolDetails | undefined> | undefined,
  state: ExtensionState,
  options: ResolvedOptions,
  owned: EngineOwned,
): Promise<ForegroundWait> => {
  const { job } = run;
  // Foreground: claim the row, stream log slices, wait with detach support.
  setForegroundClaim(owned.session.spoolDir, job.jobId);
  state.foregroundRuns.set(toolCallId, {
    command: input.command,
    name: input.name,
    startedAt: Date.now(),
  });
  let logOffset = 0;
  try {
    logOffset = sizeOf(job.logFile);
  } catch {
    logOffset = 0;
  }
  // CC parity: the detach hint rides the first streaming tick, so it shows
  // even when presentation layers don't render their own call-row hint —
  // including silent commands that never produce an output slice.
  let hintSent = options.detachShortcut === false;
  const detachHintSuffix = typeof options.detachShortcut === "string" ? `\n(${options.detachShortcut} to background)` : "";
  const detachHintStandalone =
    typeof options.detachShortcut === "string" ? `(${options.detachShortcut} to background)` : "";
  // S6 liveness: the reconciler steals claims older than claimStealAfterMs
  // (~45s by default). A live foreground waiter must therefore refresh the
  // heartbeat while it waits, or long foreground runs (> steal window, up
  // to maxTimeoutSeconds) look dead and get double-delivered (background
  // follow-up + foreground result). Throttled to ~10s; best-effort.
  let lastClaimRefresh = Date.now();
  const streamTimer = setInterval(() => {
    try {
      const now = Date.now();
      if (now - lastClaimRefresh >= 10000) {
        lastClaimRefresh = now;
        try {
          refreshForegroundClaim(owned.session.spoolDir, job.jobId);
        } catch {
          // Journal write is best-effort; the wait owns the result.
        }
      }
      const size = sizeOf(job.logFile);
      if (size > logOffset) {
        const slice = readByteSlice(job.logFile, logOffset, size);
        logOffset = size;
        if (slice.trim().length > 0) {
          if (hintSent) {
            onUpdate?.(bashUpdate(slice));
          } else {
            hintSent = true;
            onUpdate?.(bashUpdate(detachHintSuffix.length > 0 ? `${slice}${detachHintSuffix}` : slice));
          }
        }
      } else if (!hintSent) {
        // Silent so far: hint-only partial so the running row advertises detach.
        hintSent = true;
        if (detachHintStandalone.length > 0) onUpdate?.(bashUpdate(detachHintStandalone));
      }
    } catch {
      // Streaming is best-effort; the wait owns the result.
    }
  }, options.foregroundBashUpdateIntervalMs);
  if (typeof streamTimer.unref === "function") streamTimer.unref();

  const waited = await waitJob(job.exitFile, {
    timeoutMs: input.timeout * 1000,
    signal,
    onDetach: () => state.detachRequested.has(toolCallId),
  }).finally(() => {
    clearInterval(streamTimer);
  });

  // Foreground-wait teardown: clear the claim + run maps. Ordering matters:
  // the completed path consumes FIRST (under the still-held claim, so the
  // tick cannot slip in between) and releases after; every other path
  // releases up front so the tick promptly owns the demoted/killed row.
  // The trailing finally re-runs this as a safety net (idempotent).
  const releaseForegroundWait = (): void => {
    clearForegroundClaim(owned.session.spoolDir, job.jobId);
    state.foregroundRuns.delete(toolCallId);
    state.detachRequested.delete(toolCallId);
  };

  let output: FormattedOutput;
  let text: string;
  try {
    output = formatOutput(readTailLines(job.logFile, options.bashContextLines), {
      fullOutputPath: job.logFile,
      showFullOutputPath: options.alwaysShowOutputFilePath,
      truncationOptions: { maxLines: options.bashContextLines, maxBytes: options.maxOutputBytes },
    });
    text = output.text;
  } catch {
    releaseForegroundWait();
    throw new Error("Error: could not read command output.");
  }
  return { waited, output, text, releaseForegroundWait };
};

/**
 * runBashJob phase 3 (settle): branch dispatch over the wait outcome.
 * Consume-before-release ordering lives here (see releaseForegroundWait).
 */
const settleForegroundWait = (
  run: BegunRun,
  input: BashInput,
  foreground: ForegroundWait,
  state: ExtensionState,
  options: ResolvedOptions,
  owned: EngineOwned,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
) => {
  const { job } = run;
  const { waited, output, text, releaseForegroundWait } = foreground;
  try {
  if (waited.status === "detached") {
    releaseForegroundWait();
    const row = state.backgroundJobs.get(job.jobId);
    if (row) row.backgrounded = true;
    state.engine?.widget?.poke();
    return {
      content: [
        {
          type: "text" as const,
          text: `The user pressed Ctrl+B and moved this command to the background themselves — your parameters were correct. Do not change them, do not kill the job, and do not rerun it. Still running in tmux window: ${run.windowName} ${job.windowId}.${run.pollSuffix}\njob_id: ${job.jobId}\nlog_path: ${job.logFile}\nResult will be reported when it finishes.\n${run.followUpLine}`,
        },
      ],
      details: { ...output.details, outcome: "detached-background" as const, displayName: run.displayName },
    };
  }

  if (waited.status === "aborted") {
    // Kill under the still-held claim (then release): a tick consuming
    // between release and kill would deliver a natural finish for a
    // deliberate kill. The txn latches, so release order is safe after.
    killGuarded(owned.session, owned.runner, job, options.ownerStaleAfterMs);
    releaseForegroundWait();
    removeJobFromState(state, job.jobId);
    state.engine?.widget?.poke();
    updateBackgroundProcessStatus(ctx, state, options);
    throw new Error(`${text}\n\nCommand aborted`);
  }

  if (waited.status === "timeout") {
    if (input.timeoutAction === "kill") {
      // Latch + kill under the still-held claim (release after): same
      // race as abort — a tick between release and kill double-reports.
      markJobNotified(owned.session, job.jobId);
      // Timeout-kill marker (patty-bg-tasks idea): the model can tell a
      // timeout kill apart from a normal failure by reading the log tail.
      try {
        appendFileSync(job.logFile, `Command timed out after ${input.timeout}s\n`);
      } catch {
        // Best-effort; the kill below still happens.
      }
      killGuarded(owned.session, owned.runner, job, options.ownerStaleAfterMs);
      removeJobFromState(state, job.jobId);
      state.engine?.widget?.poke();
      updateBackgroundProcessStatus(ctx, state, options);
      throw new Error(`${text}\n\nCommand timed out after ${input.timeout} seconds`);
    }
    releaseForegroundWait();
    const row = state.backgroundJobs.get(job.jobId);
    if (row) row.backgrounded = true;
    state.engine?.widget?.poke();
    const body = buildTimeoutText({
      text,
      timeoutSeconds: input.timeout,
      pollClause: run.requestedPollInterval > 0 ? ` and polling every ${run.pollInterval}s` : "",
      hint: timeoutBackgroundHint(options),
      timeoutAction: input.timeoutAction,
      followUpLine: run.followUpLine,
      jobId: job.jobId,
      logFile: job.logFile,
    });
    return {
      content: [
        {
          type: "text" as const,
          text: body,
        },
      ],
      details: { ...output.details, outcome: "timed-out-background" as const, displayName: run.displayName },
    };
  }

  // Completed foreground: consume while OUR claim is still held, so the
  // tick cannot slip in between (claim cleared only after). If the tick won
  // anyway (stale claim stolen mid-wait), consume returns undefined and the
  // tick's follow-up owns the delivery: point at it instead of reporting
  // (and never throw — the outcome is already delivered).
  const completion = consumeCompletion(owned.session, job.jobId);
  releaseForegroundWait();
  if (!completion) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Result already reported via background completion for job ${job.jobId}. Follow up with /tasks ${job.jobId} or read ${job.logFile}.`,
        },
      ],
      details: { ...output.details, displayName: run.displayName },
    };
  }
  closeWindow(state, job.jobId, options.ownerStaleAfterMs);
  removeJobFromState(state, job.jobId);
  state.engine?.widget?.poke();
  updateBackgroundProcessStatus(ctx, state, options);
  if (waited.exitCode !== 0) {
    throw new Error(`${text}\n\nCommand exited with code ${waited.exitCode}`);
  }
  return { content: [{ type: "text" as const, text }], details: { ...output.details, displayName: run.displayName } };
  } finally {
    releaseForegroundWait();
  }
};

const sizeOf = (path: string): number => statSync(path).size;

/**
 * Background completion delivery (reconciler onCompletion target): same
 * customType, same follow-up shape, same toast, same window close as legacy.
 */
/** Local teardown shared by delivered and suppressed completions. */
const teardownCompleted = (
  state: ExtensionState,
  options: ResolvedOptions,
  jobId: string,
): void => {
  closeWindow(state, jobId, options.ownerStaleAfterMs);
  removeJobFromState(state, jobId);
  updateStoredBackgroundProcessStatus(state, options);
};

export const deliverCompletion = (
  pi: ExtensionAPI,
  state: ExtensionState,
  options: ResolvedOptions,
  snapshot: JobSnapshot,
  exitCode: number,
  suppressed = false,
): void => {
  const owned = engineOf(state);
  if (!owned) return;
  // Suppressed (latched reads/kills): outcome already surfaced, so clean up
  // silently — no message, no toast, no finished row.
  if (suppressed) {
    teardownCompleted(state, options, snapshot.jobId);
    owned.widget?.poke();
    return;
  }
  const job = state.backgroundJobs.get(snapshot.jobId);
  const output = formatOutput(readTailLines(snapshot.logFile, options.completedContextLines), {
    fullOutputPath: snapshot.logFile,
    showFullOutputPath: options.alwaysShowOutputFilePath,
    truncationOptions: { maxLines: options.completedContextLines, maxBytes: options.maxOutputBytes },
  });
  // Singleton completions steer mid-turn (patty-bg-tasks parity): the agent
  // reacts between tool calls instead of waiting for the next turn.
  pi.sendMessage(
    completionCustomMessage(exitCode, output, {
      job,
      windowId: snapshot.windowId,
    }),
    { triggerTurn: true, deliverAs: "steer" },
  );
  notifyCompletion(state, options, exitCode, job?.command);
  teardownCompleted(state, options, snapshot.jobId);
  owned.widget?.noteFinished(snapshot.jobId, snapshot.command, exitCode, Date.now() - snapshot.startedAt);
  owned.widget?.poke();
};

/**
 * Batched completion delivery (reconciler onCompletions target): every job
 * consumed in one tick reports in ONE follow-up turn. Singleton batches
 * reuse the single path verbatim (frozen shape); multi batches use one
 * combined message with identical per-job blocks so model habits transfer.
 */
export const deliverCompletions = (
  pi: ExtensionAPI,
  state: ExtensionState,
  options: ResolvedOptions,
  items: CompletionItem[],
): void => {
  if (items.length === 0) return;
  // Suppressed items clean up silently first; the message covers live ones.
  for (const item of items) {
    if (item.suppressed) deliverCompletion(pi, state, options, item.job, item.exitCode, true);
  }
  const live = items.filter((item) => !item.suppressed);
  if (live.length === 0) return;
  if (live.length === 1) {
    const only = live[0];
    deliverCompletion(pi, state, options, only.job, only.exitCode);
    return;
  }
  const owned = engineOf(state);
  if (!owned) return;
  const blocks: BatchBlock[] = live.map((item) => {
    const job = state.backgroundJobs.get(item.job.jobId);
    const command = job?.command ?? item.job.command;
    const output = formatOutput(
      readTailLines(item.job.logFile, options.completedContextLines),
      {
        fullOutputPath: item.job.logFile,
        showFullOutputPath: options.alwaysShowOutputFilePath,
        truncationOptions: { maxLines: options.completedContextLines, maxBytes: options.maxOutputBytes },
      },
    );
    return {
      jobId: item.job.jobId,
      command,
      // Display-resolved name when available (syncJobToState resolves it).
      name: job?.name,
      exitCode: item.exitCode,
      logFile: item.job.logFile,
      logTail: item.logTail,
      startedAt: item.job.startedAt,
      output,
      identity: {
        job: state.backgroundJobs.get(item.job.jobId),
        windowId: item.job.windowId,
      },
    };
  });
  const { message, notifyLabel, worst } = buildBatchCompletion(blocks, options);
  pi.sendMessage(message, { triggerTurn: true, deliverAs: "followUp" });
  notifyCompletion(state, options, worst, notifyLabel);
  for (const block of blocks) {
    closeWindow(state, block.jobId, options.ownerStaleAfterMs);
    removeJobFromState(state, block.jobId);
    owned.widget?.noteFinished(
      block.jobId,
      block.command,
      block.exitCode,
      Date.now() - block.startedAt,
    );
  }
  owned.widget?.poke();
  updateStoredBackgroundProcessStatus(state, options);
};

/** Interim poll fan-out (reconciler onPoll target): model vs display routing preserved. */
export const deliverPoll = (
  pi: ExtensionAPI,
  state: ExtensionState,
  options: ResolvedOptions,
  snapshot: JobSnapshot,
  newText: string,
): void => {
  const owned = engineOf(state);
  if (!owned) return;
  const output = formatOutput(newText, {
    fullOutputPath: snapshot.logFile,
    showFullOutputPath: options.alwaysShowOutputFilePath,
    truncationOptions: { maxLines: options.pollContextLines, maxBytes: options.maxOutputBytes },
  });
  const message = pollCustomMessage(
    {
      id: snapshot.windowId,
      index: 0,
      title: snapshot.command.split("\n")[0].slice(0, 60) || snapshot.windowId,
      active: false,
      displayCommand: snapshot.command,
      outputFile: snapshot.logFile,
      jobId: snapshot.jobId,
    },
    output,
    options,
    owned.session.socketName,
  );
  if (options.pollDelivery === "model") {
    pi.sendMessage(message, { triggerTurn: true, deliverAs: "followUp" });
  } else {
    sendPollMessageWhenIdle(pi, state, message);
  }
};

/**
 * Stall warning (reconciler onStall target): the log went static with an
 * interactive-prompt tail. Steer delivery — a blocked job needs attention
 * mid-turn. Never touches the notified latch and consumes nothing; a later
 * real completion still notifies. Remediation rides along as plain text.
 */
export const deliverStall = (
  pi: ExtensionAPI,
  state: ExtensionState,
  options: ResolvedOptions,
  snapshot: JobSnapshot,
  tail: string,
): void => {
  if (!engineOf(state)) return;
  const job = state.backgroundJobs.get(snapshot.jobId);
  const command = job?.command ?? snapshot.command;
  const label = command.split("\n")[0].slice(0, 80);
  const summary = `Background command "${label}" appears to be waiting for interactive input`;
  const content = [
    summary,
    `job ${snapshot.jobId} ($ ${label})`,
    `log_path: ${snapshot.logFile}`,
    "",
    "Last output:",
    tail.trimEnd(),
    "",
    "The command is likely blocked on an interactive prompt. Kill it with " +
      `/tasks ${snapshot.jobId} and re-run with piped input (e.g. \`echo y | command\`) ` +
      `or a non-interactive flag if one exists.`,
  ].join("\n");
  pi.sendMessage(
    {
      customType: "tmux-bash-stall",
      content,
      details: { jobId: snapshot.jobId, logPath: snapshot.logFile, summary },
      display: true,
    },
    { triggerTurn: true, deliverAs: "steer" },
  );
};

// --- /tasks + bg tool helpers (sidecar-backed) ---

export interface TaskRow {
  jobId: string;
  windowId: string;
  name?: string;
  command: string;
  status: string;
  logFile: string;
  startedAt: number;
  /**
   * Finished (exit file present) but not yet delivered: outcome waiting
   * to be read. Set from the journal, not the latch.
   */
  unread?: boolean;
}

/**
 * Resolve where a job actually lives: own spool dir by default, the adopted
 * dir (with its own tmux socket) for adopted orphans. Registry rows carry
 * the spoolDir marker; without it we assume owned (pre-marker records).
 */
const resolveJobTarget = (
  state: ExtensionState,
  jobId: string,
): { spoolDir: string; session: Session; runner: Runner } | undefined => {
  const owned = engineOf(state);
  if (!owned) return undefined;
  const spoolDir = state.backgroundJobs.get(jobId)?.engine?.spoolDir ?? owned.session.spoolDir;
  if (spoolDir === owned.session.spoolDir) {
    return { spoolDir, session: owned.session, runner: owned.runner };
  }
  const adopted = owned.adopted?.get(spoolDir);
  if (!adopted) return undefined;
  return { spoolDir, session: adopted.session, runner: owned.runner };
};

export const listTasks = (state: ExtensionState): TaskRow[] => {
  const owned = engineOf(state);
  if (!owned) return [];
  const dirs = [owned.session.spoolDir, ...[...(owned.adopted?.keys() ?? [])]];
  const rows: TaskRow[] = [];
  for (const spoolDir of dirs) {
    let files: string[];
    try {
      files = readdirSync(`${spoolDir}/jobs`);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const record = readJsonFile<JobRecord>(`${spoolDir}/jobs/${file}`);
      if (!record || record.status !== "running") continue;
      rows.push({
        jobId: record.jobId,
        windowId: record.windowId,
        name: record.name,
        command: record.command,
        status: record.status,
        logFile: record.spoolLog,
        startedAt: record.startedAt ?? Date.now(),
        // Exit file present, undelivered, unlatched: finished, unread outcome.
        // (Latched rows were already read — no unread badge for seen output.)
        ...(existsSync(record.exitFile) && record.seen !== true
          ? { unread: true as const }
          : {}),
      });
    }
  }
  return rows;
};

export const peekTask = (state: ExtensionState, jobId: string, contextLines: number): string | undefined => {
  const target = resolveJobTarget(state, jobId);
  if (!target) return undefined;
  const record = readJsonFile<JobRecord>(jobJsonPath(target.spoolDir, jobId));
  if (!record) return undefined;
  // Reading a finished job surfaces its outcome: latch before returning so
  // the pending completion ping never fires for already-seen output.
  // Shadows show the live pane (not a final outcome) and delivered rows
  // need no latch — both skip.
  if (record.status === "running" && existsSync(record.exitFile)) {
    markJobNotified(target.session, jobId);
  }
  const text = peekJob(
    target.session,
    target.runner,
    {
      jobId,
      windowId: record.windowId,
      command: record.command,
      windowName: record.windowName ?? record.command.split("\n")[0].slice(0, 60),
    },
    contextLines,
  );
  return `Peeked on tmux task ${jobId}\n${text}\nlog_path: ${record.spoolLog}`;
};

export const killTask = (state: ExtensionState, options: ResolvedOptions, jobId: string): boolean => {
  const target = resolveJobTarget(state, jobId);
  if (!target) return false;
  const record = readJsonFile<JobRecord>(jobJsonPath(target.spoolDir, jobId));
  if (!record) return false;
  // The latch lives in the killGuarded txn (a refused kill latches nothing:
  // a death we did not cause is not a deliberate one).
  const result = killGuarded(
    target.session,
    target.runner,
    { jobId, windowId: record.windowId },
    options.ownerStaleAfterMs,
  );
  removeJobFromState(state, jobId);
  updateStoredBackgroundProcessStatus(state, options);
  return result !== "refused";
};
