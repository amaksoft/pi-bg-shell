import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ResolvedOptions, TmuxAction } from "../config";
import {
  formatCompletionSummary,
  formatRenderedBashResult,
  formatTmuxOutputForContext as formatOutput,
  hasOnlyEmptyBashOutput,
  type CompletionMessageRenderDetails,
  type FormattedOutput,
} from "../render";
import { resolveDisplayName } from "./grammar";
import type { BackgroundJob } from "./types";

// --- Job naming -----------------------------------------------------------

/** Display priority: given name > short command verbatim > derived label. */
export const DISPLAY_COMMAND_LIMIT = 60;

// --- Hints ----------------------------------------------------------------

export const timeoutBackgroundHint = (options: ResolvedOptions): string => {
  const actions = (["peek", "list", "kill"] as TmuxAction[]).filter((action) =>
    options.tmuxEnabledActions.includes(action),
  );
  if (actions.length === 0) return "Result will be reported when it finishes.";
  return `Use ${options.tmuxToolName} ${actions.join("/")} to inspect or stop it. Result will be reported when it finishes.`;
};

// --- Completion messages --------------------------------------------------

export type CompletionIdentity = {
  job?: BackgroundJob;
  windowId: string;
};

export const completionMessageDetails = (
  exitCode: number,
  output: FormattedOutput,
  identity?: CompletionIdentity,
): CompletionMessageRenderDetails => ({
  v: 1,
  summary: formatCompletionSummary(exitCode),
  output: output.details.render,
  exitCode,
  status: exitCode === 0 ? "success" : "failed",
  jobId: identity?.job?.jobId,
  command: identity?.job?.command,
  logPath: identity?.job?.outputFile,
  windowId: identity?.windowId,
  // Collapsed aggregate header reads this (given name > short command).
  ...(identity?.job ? { displayName: resolveDisplayName(identity.job.command, identity.job.name) } : {}),
});

type CustomMessageInput = Parameters<ExtensionAPI["sendMessage"]>[0];

export const completionCustomMessage = (
  exitCode: number,
  output: FormattedOutput,
  identity?: CompletionIdentity,
): CustomMessageInput => {
  const details = completionMessageDetails(exitCode, output, identity);
  const header = [
    details.summary,
    details.jobId
      ? `job ${details.jobId}${details.command ? ` ($ ${details.command.slice(0, 80)})` : ""}`
      : undefined,
    details.logPath ? `log_path: ${details.logPath}` : undefined,
  ].filter((line): line is string => line !== undefined);
  const content = hasOnlyEmptyBashOutput(details.output)
    ? header.join("\n")
    : `${header.join("\n")}\n\n\`\`\`\n${formatRenderedBashResult(details.output, { expanded: true })}\n\`\`\``;
  return { customType: "tmux-bash-completion", content, details, display: true };
};

export type BatchBlock = {
  jobId: string;
  command: string;
  /** Display-resolved name when available (syncJobToState resolves it). */
  name?: string;
  exitCode: number;
  logFile: string;
  logTail: string;
  startedAt: number;
  output: FormattedOutput;
  identity?: CompletionIdentity;
};

/**
 * One combined completion message for a batch of jobs (single shape for
 * singletons-by-batch and herds; per-job blocks so model habits transfer).
 * Pure: all IO (log reads) happens in the block inputs.
 */
export const buildBatchCompletion = (
  blocks: BatchBlock[],
  options: ResolvedOptions,
): { message: CustomMessageInput; notifyLabel: string; worst: number } => {
  const worst = blocks.some((b) => b.exitCode !== 0)
    ? blocks.find((b) => b.exitCode !== 0)!.exitCode
    : 0;
  const lines: string[] = [`Background bash finished (${blocks.length} jobs)`];
  for (const block of blocks) {
    lines.push(
      "",
      `job ${block.jobId} ($ ${block.command.split("\n")[0].slice(0, 80)}): exit ${block.exitCode}`,
      `log_path: ${block.logFile}`,
    );
    const tail = block.logTail.trim();
    if (tail.length > 0) lines.push("```", tail, "```");
    else lines.push("(no output)");
  }
  const combined = formatOutput(lines.join("\n"), {
    fullOutputPath: undefined,
    showFullOutputPath: false,
    truncationOptions: { maxLines: options.completedContextLines * blocks.length, maxBytes: options.maxOutputBytes },
  });
  const first = blocks[0];
  const message = {
    customType: "tmux-bash-completion",
    content: lines.join("\n"),
    details: {
      ...completionMessageDetails(worst, combined, first.identity),
      jobs: blocks.map((block) => ({
        jobId: block.jobId,
        command: block.command,
        displayName: block.name ?? block.command,
        exitCode: block.exitCode,
        logPath: block.logFile,
        tail: block.logTail.trim(),
      })),
    },
    display: true,
  };
  const notifyLabel = `${blocks.length} jobs: ${blocks.map((b) => b.command.split("\n")[0].slice(0, 40)).join(", ")}`;
  return { message, notifyLabel, worst };
};

// --- Launch / timeout texts -----------------------------------------------

/** Frozen background-launch text (contract): identity + retrieval + follow-up. */
export const buildLaunchText = (input: {
  windowName: string;
  windowId: string;
  jobId: string;
  logFile: string;
  pollSuffix: string;
  followUpLine: string;
}): string =>
  `Started in background tmux window: ${input.windowName} ${input.windowId}.${input.pollSuffix}\njob_id: ${input.jobId}\nlog_path: ${input.logFile}\nResult will be reported when it finishes.\n${input.followUpLine}`;

/** Frozen timeout-demote text: prior output + still-running line + decision. */
export const buildTimeoutText = (input: {
  text: string;
  timeoutSeconds: number;
  /** ` and polling every Ns` or `""`. */
  pollClause: string;
  hint: string;
  timeoutAction: "kill" | "background" | "ask" | undefined;
  followUpLine: string;
  jobId: string;
  logFile: string;
}): string => {
  const timeoutText = `Still running after ${input.timeoutSeconds}s in background tmux${input.pollClause}. ${input.hint}`;
  const detachedText = [input.text, timeoutText].filter(Boolean).join("\n\n");
  // "ask" (the default): the job survives demoted, but the model decides
  // its fate on the next turn — kill via /tasks, or leave it and the
  // completion will report. Same outcome shape (it IS backgrounded now),
  // decision framing instead of a standing order.
  const askLine =
    input.timeoutAction === "ask"
      ? `\nYour call: leave it running and the result will be reported when it finishes, or kill it now with /tasks ${input.jobId}.`
      : `\n${input.followUpLine}`;
  return `${detachedText}\njob_id: ${input.jobId}\nlog_path: ${input.logFile}${askLine}`;
};

/** Shutdown warning listing killed jobs + the keep-alive setting. Undefined when silent. */
export const shutdownWarningText = (
  doomed: { name?: string; command: string }[],
): string | undefined => {
  if (doomed.length === 0) return undefined;
  const names = doomed
    .map((job) => job.name ?? job.command.split("\n")[0])
    .slice(0, 3)
    .join(", ");
  const rest = doomed.length > 3 ? ` (+${doomed.length - 3} more)` : "";
  return `Stopped ${doomed.length} background job${doomed.length === 1 ? "" : "s"} on exit: ${names}${rest}. Set shutdownPolicy "leave-running" to keep them next time.`;
};
