import { Text, truncateToWidth, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { ResolvedOptions } from "../config";
import {
  formatRenderedPollMessage,
  indentDisplayLine,
  type BashOutputRenderDetails,
  type BashOutputRenderLine,
  type CompletionJobRow,
  type CompletionMessageRenderDetails,
  type PollMessageRenderDetails,
} from "../render";
import {
  batchSummary,
  branchLines,
  BRANCH_LEAD,
  displayNameOf as grammarDisplayName,
  expandHintSegments,
  nonBlankLines,
  singleSummary,
  verdictSegments,
  type Segment,
} from "../engine/grammar";

type Guarded<T> = T | undefined;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const guardOutputLine = (value: unknown): value is BashOutputRenderLine => {
  const line = asRecord(value);
  if (!line || typeof line.text !== "string") return false;
  if (line.kind === "output" || line.kind === "truncationNotice") return true;
  return line.kind === "fullOutputNotice" && typeof line.displayText === "string";
};

const guardOutput = (value: unknown): value is BashOutputRenderDetails => {
  const details = asRecord(value);
  return (
    !!details &&
    Array.isArray(details.lines) &&
    (details.lines as unknown[]).every(guardOutputLine) &&
    typeof details.empty === "boolean"
  );
};

const guardJobRow = (row: unknown): row is CompletionJobRow => {
  const candidate = asRecord(row);
  return (
    !!candidate &&
    typeof candidate.jobId === "string" &&
    typeof candidate.command === "string" &&
    typeof candidate.exitCode === "number" &&
    typeof candidate.logPath === "string" &&
    typeof candidate.tail === "string" &&
    (candidate.displayName === undefined || typeof candidate.displayName === "string")
  );
};

const guardCompletion = (value: unknown): Guarded<CompletionMessageRenderDetails> => {
  const details = asRecord(value);
  if (!details) return undefined;
  if (typeof details.summary !== "string") return undefined;
  if (!guardOutput(details.output)) return undefined;
  if (typeof details.exitCode !== "number") return undefined;
  if (details.status !== "success" && details.status !== "failed") return undefined;
  if (details.displayName !== undefined && typeof details.displayName !== "string") return undefined;
  const jobs = Array.isArray(details.jobs) && (details.jobs as unknown[]).every(guardJobRow)
    ? (details.jobs as CompletionJobRow[])
    : undefined;
  return {
    v: typeof details.v === "number" ? details.v : 1,
    summary: details.summary as string,
    output: details.output as BashOutputRenderDetails,
    exitCode: details.exitCode as number,
    status: details.status as "success" | "failed",
    // Identity extras pass through for adapters; absence stays valid.
    ...(typeof details.jobId === "string" ? { jobId: details.jobId } : {}),
    ...(typeof details.command === "string" ? { command: details.command } : {}),
    ...(typeof details.logPath === "string" ? { logPath: details.logPath } : {}),
    ...(typeof details.windowId === "string" ? { windowId: details.windowId } : {}),
    ...(typeof details.displayName === "string" ? { displayName: details.displayName } : {}),
    ...(jobs ? { jobs } : {}),
  };
};

const guardPoll = (value: unknown): Guarded<PollMessageRenderDetails> => {
  const details = asRecord(value);
  if (!details) return undefined;
  if (typeof details.summary !== "string") return undefined;
  if (typeof details.command !== "string") return undefined;
  if (!guardOutput(details.output)) return undefined;
  if (!asStrings(details.attachLines)) return undefined;
  return {
    summary: details.summary,
    command: details.command,
    output: details.output as BashOutputRenderDetails,
    attachLines: details.attachLines,
  };
};

const rawText = (message: { content?: unknown }): string =>
  typeof message.content === "string" && message.content.length > 0
    ? message.content
    : "Background bash update";

/**
 * Tool chrome for completion/poll rows (display-only), expressed through the
 * pi Theme — never hardcoded ANSI. Header grammar mirrors tool-chrome
 * exactly: `{dot} {bold tool}({summary})`, detail branch `  ⎿  `, muted
 * hints. Message content (what the model reads) is untouched throughout.
 */
/** Paint tone segments through the theme (grammar decides, chrome colors). */
const paint = (segments: Segment[], theme: Theme): string =>
  segments.map((segment) => theme.fg(segment.tone, segment.text)).join("");

const branch = (content: string, theme: Theme): string[] =>
  branchLines(content).map((line, index) =>
    index === 0 ? theme.fg("muted", BRANCH_LEAD) + line.slice(BRANCH_LEAD.length) : line,
  );

/**
 * Collapsed aggregate header, mirroring claudify's settled-bash chrome:
 * tool label + status dot, then the greyed-out substitution carrying the
 * display name (`Ran 1 shell command: <name>`) instead of the raw command.
 */
const chromeHeader = (summary: string, exitCode: number, theme: Theme): string => {
  const dot = theme.fg(exitCode === 0 ? "success" : "error", "⏺");
  return `${dot} ${theme.fg("toolTitle", theme.bold("Bash"))}${theme.fg("muted", `(${summary})`)}`;
};

const aggregateHeader = (name: string, jobId: string | undefined, exitCode: number, theme: Theme): string =>
  chromeHeader(singleSummary(name, jobId), exitCode, theme);

const batchHeader = (count: number, exitCode: number, theme: Theme): string =>
  chromeHeader(batchSummary(count), exitCode, theme);

const detailHeader = (
  command: string | undefined,
  jobId: string | undefined,
  exitCode: number,
  theme: Theme,
): string => {
  const cmd = (command ?? "shell").split("\n")[0].slice(0, 60) || "shell";
  const id = jobId ? ` · job ${jobId}` : "";
  const dot = theme.fg(exitCode === 0 ? "success" : "error", "⏺");
  return `${dot} ${theme.fg("toolTitle", theme.bold("Bash"))}($ ${cmd}${id})`;
};

const resultLine = (exitCode: number, tailCount: number, theme: Theme): string =>
  paint(verdictSegments(exitCode, tailCount), theme);

const expandHint = (theme: Theme): string => paint(expandHintSegments(), theme);

/**
 * Clickable completion block: collapsed summary + hint, click anywhere
 * toggles the full output. Initializes from pi's expanded flag (ctrl+o keeps
 * working). Display-only: message content is untouched.
 */
class ExpandableCompletion implements Component {
  private open: boolean;

  constructor(
    private readonly collapsed: string[],
    private readonly expanded: string[],
    initialOpen: boolean,
  ) {
    this.open = initialOpen;
  }

  render(width: number): string[] {
    const lines = this.open ? this.expanded : this.collapsed;
    return lines.map((line) => truncateToWidth(line, Math.max(20, width)));
  }

  invalidate(): void {}

  handleMouse(event: TuiMouseEvent): { handled: boolean } | undefined {
    if (event.type === "click") {
      this.open = !this.open;
      return { handled: true };
    }
    return undefined;
  }
}

/** Non-blank output texts (claudify counts content lines, not blanks). */
const outputTexts = (details: CompletionMessageRenderDetails): string[] =>
  nonBlankLines(
    details.output.lines
      .filter((line) => line.kind === "output")
      .map((line) => (line as { text: string }).text),
  );

const displayNameOf = (details: CompletionMessageRenderDetails): string =>
  grammarDisplayName(details.command, details.displayName);

const renderSingle = (
  details: CompletionMessageRenderDetails,
  expanded: boolean,
  options: ResolvedOptions,
  theme: Theme,
): Component => {
  const header = aggregateHeader(displayNameOf(details), details.jobId, details.exitCode, theme);
  const texts = outputTexts(details);
  const verdict = resultLine(details.exitCode, texts.length, theme);
  // Collapsed: verdict + keyboard hint only, no preview lines (claudify:
  // `Done (N lines) (ctrl+o to expand)`). Empty: static, nothing to expand.
  if (texts.length === 0) return new Text([header, ...branch(verdict, theme)].join("\n"), 0, 0);
  const collapsedBody = `${verdict}${expandHint(theme)}`;
  const full = [verdict, ...texts.slice(-options.completedExpandedDisplayLines)].join("\n");
  return new ExpandableCompletion(
    [header, ...branch(collapsedBody, theme)],
    [header, ...branch(full, theme)],
    expanded,
  );
};

const renderBatch = (
  jobs: CompletionJobRow[],
  expanded: boolean,
  options: ResolvedOptions,
  theme: Theme,
): Component => {
  const failed = jobs.filter((job) => job.exitCode !== 0);
  const worst = failed.length > 0 ? (failed[0]?.exitCode ?? 1) : 0;
  const header = batchHeader(jobs.length, worst, theme);
  // Batch verdict carries no line count (jobs, not lines, aggregated).
  const verdict =
    failed.length === 0 ? theme.fg("success", "Done") : theme.fg("error", `Exit ${worst}`);
  const blocks: string[] = [];
  for (const job of jobs) {
    const tail = job.tail
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0)
      .slice(-options.completedExpandedDisplayLines);
    blocks.push(detailHeader(job.displayName ?? job.command, job.jobId, job.exitCode, theme));
    if (tail.length > 0) {
      for (const line of branch([resultLine(job.exitCode, tail.length, theme), ...tail].join("\n"), theme)) {
        blocks.push(line);
      }
    } else {
      for (const line of branch(resultLine(job.exitCode, 0, theme), theme)) blocks.push(line);
      blocks.push(theme.fg("dim", "⎿ (no output)"));
    }
  }
  return new ExpandableCompletion(
    [header, ...branch(`${verdict}${expandHint(theme)}`, theme)],
    [header, ...blocks],
    expanded,
  );
};

export const registerMessageRenderers = (pi: ExtensionAPI, options: ResolvedOptions): void => {
  pi.registerMessageRenderer("tmux-bash-poll", (message, { expanded }, theme) => {
    // Plain-chrome fallback: unstyled model text, no blocks.
    if (options.plainChrome) return new Text(rawText(message), 0, 0);
    const details = guardPoll(message.details);
    // Degrade to raw content: never crash the transcript on reshaped details.
    if (!details) return new Text(rawText(message), 0, 0);
    const rendered = formatRenderedPollMessage({ details, expanded, options });
    const [summary = "", ...rest] = rendered.split("\n");
    const head = theme.fg("success", indentDisplayLine(summary));
    return new Text(rest.length > 0 ? `${head}\n${theme.fg("dim", rest.join("\n"))}` : head, 0, 0);
  });

  pi.registerMessageRenderer("tmux-bash-completion", (message, { expanded }, theme) => {
    // Plain-chrome fallback: unstyled model text, no blocks.
    if (options.plainChrome) return new Text(rawText(message), 0, 0);
    const details = guardCompletion(message.details);
    // Degrade to raw content: never crash the transcript on reshaped details.
    if (!details) return new Text(rawText(message), 0, 0);
    const jobs = details.jobs !== undefined && details.jobs.length > 1 ? details.jobs : undefined;
    if (jobs) return renderBatch(jobs, expanded, options, theme);
    return renderSingle(details, expanded, options, theme);
  });
};
