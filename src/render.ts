import { Container, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import {
  DEFAULT_MAX_BYTES,
  formatSize,
  keyHint,
  keyText,
  truncateTail,
  truncateToVisualLines,
  type BashToolDetails,
  type TruncationOptions,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { BASH_DURATION_SEPARATOR, DEFAULT_OPTIONS, type ResolvedOptions } from "./config";
import type { BashInput } from "./tool-call-schemas";

export type RenderTheme = {
  fg: (name: "toolTitle" | "toolOutput" | "muted" | "dim" | "warning", text: string) => string;
  bold: (text: string) => string;
};

export type BashOutputRenderLine =
  | { kind: "output"; text: string }
  | { kind: "fullOutputNotice"; text: string; displayText: string }
  | { kind: "truncationNotice"; text: string };

export type BashOutputRenderDetails = {
  lines: BashOutputRenderLine[];
  empty: boolean;
};

export type TmuxBashToolDetails = BashToolDetails & {
  outcome?: "timed-out-background" | "detached-background";
  render: BashOutputRenderDetails;
  /** Human label for grouped summaries ("ran <displayName>"). Engine-set. */
  displayName?: string;
};

export type FormattedOutput = {
  text: string;
  details: TmuxBashToolDetails;
}

export type CompletionMessageRenderDetails = {
  /** Chrome-view schema version (additive: readers ignore unknown fields). */
  v: number;
  summary: string;
  output: BashOutputRenderDetails;
  exitCode: number;
  status: "success" | "failed";
  /** Opaque bg-shell job identity (absent for windows launched outside this session). */
  jobId?: string;
  command?: string;
  logPath?: string;
  windowId?: string;
  /** Display-resolved name (given name > short command > derived label). */
  displayName?: string;
  /** Batched completions: per-job rows for the expanded aggregate view. */
  jobs?: CompletionJobRow[];
};

export type CompletionJobRow = {
  jobId: string;
  /** Original command (stable for matching; never the display name). */
  command: string;
  /** Display-resolved name when available (given name > short command). */
  displayName?: string;
  exitCode: number;
  logPath: string;
  /** Exact tail text (may be empty). */
  tail: string;
};

export type PollMessageRenderDetails = {
  summary: string;
  command: string;
  output: BashOutputRenderDetails;
  attachLines: string[];
};

type LineBudget = {
  expanded: boolean;
  compactDisplayLines?: number;
  expandedDisplayLines?: number;
  truncatedCompactDisplayLines?: number;
};

type ContextFormatOptions = {
  fullOutputPath?: string;
  emptyText?: string;
  showFullOutputPath?: boolean;
  truncationOptions?: TruncationOptions;
};

type BackgroundResultOptions = {
  raw: string;
  details?: BashOutputRenderDetails;
  expanded: boolean;
  theme: RenderTheme;
  options?: ResolvedOptions;
};

type TimingState = {
  startedAt?: number;
  endedAt?: number;
};

type ForegroundResultOptions = Omit<BackgroundResultOptions, "details"> & {
  isPartial: boolean;
  state: TimingState;
  details?: TmuxBashToolDetails;
};

type ElisionLine =
  | { kind: "collapsedElision"; text: string; prefix: string; key: string; suffix: string }
  | { kind: "expandedElision"; text: string };

type VisibleLine = BashOutputRenderLine | ElisionLine;

/** Strip the shim preamble: show only the user's command after the marker. */
export const displayCommandForCommand = (
  cmd: string,
  marker = DEFAULT_OPTIONS.displayCommandStartMarker,
): string => {
  if (!marker) return cmd;
  const lines = cmd.split("\n");
  const fromEnd = [...lines].reverse().findIndex((line) => line.trim() === marker);
  if (fromEnd === -1) return cmd;
  const markerIndex = lines.length - fromEnd - 1;
  return lines.slice(markerIndex + 1).join("\n").trimStart() || cmd;
};

const dropTrailingBlanks = (lines: string[]): string[] => {
  const lastContent = [...lines].reverse().findIndex((line) => line.trim() !== "");
  if (lastContent === -1) return [];
  return lines.slice(0, lines.length - lastContent);
};

const detailsOf = (content: string, empty = false): BashOutputRenderDetails => ({
  lines: dropTrailingBlanks(content.split("\n")).map((text) => ({ kind: "output", text })),
  empty,
});

const bytesOfLastLine = (content: string): number =>
  Buffer.byteLength(content.split("\n").at(-1) ?? "", "utf-8");

const overLineLimit = (content: string, maxLines: number | undefined): boolean =>
  maxLines !== undefined && content.split("\n").length > maxLines;

const truncationText = (
  content: string,
  truncation: TruncationResult,
  fullOutputPath: string | undefined,
): string => {
  const first = truncation.totalLines - truncation.outputLines + 1;
  const last = truncation.totalLines;
  const suffix = fullOutputPath ? `. Full output: ${fullOutputPath}` : "";
  if (truncation.lastLinePartial) {
    const lineSize = formatSize(bytesOfLastLine(content));
    return `[Showing last ${formatSize(truncation.outputBytes)} of line ${last} (line is ${lineSize})${suffix}]`;
  }
  if (truncation.truncatedBy === "lines") {
    return `[Showing lines ${first}-${last} of ${truncation.totalLines}${suffix}]`;
  }
  return `[Showing lines ${first}-${last} of ${truncation.totalLines} (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)${suffix}]`;
};

/** Truncate output for model context, keeping render details for display. */
export const formatTmuxOutputForContext = (
  content: string,
  {
    fullOutputPath,
    emptyText = "(no output)",
    showFullOutputPath = false,
    truncationOptions = {},
  }: ContextFormatOptions = {},
): FormattedOutput => {
  const empty = !content.trim();
  const text = content.trim() || emptyText;
  const maxBytes = truncationOptions.maxBytes ?? DEFAULT_MAX_BYTES;
  const singleHugeLine =
    content.endsWith("\n") && !text.includes("\n") && Buffer.byteLength(text, "utf-8") > maxBytes;
  const source = singleHugeLine || overLineLimit(content, truncationOptions.maxLines) ? content : text;
  const truncation = truncateTail(source, truncationOptions);
  const output = truncation.truncated ? truncation.content || emptyText : text;
  const notice: BashOutputRenderLine | undefined = truncation.truncated
    ? { kind: "truncationNotice", text: truncationText(source, truncation, fullOutputPath) }
    : showFullOutputPath && fullOutputPath
      ? {
          kind: "fullOutputNotice",
          text: `[Full output: ${fullOutputPath}]`,
          displayText: `Full output: ${fullOutputPath}`,
        }
      : undefined;
  const render = detailsOf(output, empty);
  return {
    text: notice ? `${output}\n\n${notice.text}` : output,
    details: {
      ...(truncation.truncated ? { truncation, fullOutputPath } : {}),
      ...(!truncation.truncated && notice ? { fullOutputPath } : {}),
      render: { lines: notice ? [...render.lines, notice] : render.lines, empty: render.empty },
    },
  };
};

/** Keep only the last N lines of (possibly blank) content. */
export const limitOutputLines = (content: string, lines: number): string => {
  const trimmed = content.trimEnd();
  if (!trimmed) return "";
  return trimmed.split("\n").slice(-lines).join("\n");
};

export const formatCompletionSummary = (exitCode: number): string =>
  exitCode === 0 ? "Background bash finished" : "Background bash failed";

export const indentDisplayLine = (line: string): string => (line.trim() ? ` ${line}` : "");

export const indentDisplayLines = (lines: string[]): string[] => lines.map(indentDisplayLine);

const shownText = (line: VisibleLine): string =>
  line.kind === "fullOutputNotice" ? line.displayText : line.text;

/** Completion detail: output lines only (no notices, blanks, or tmux errors). */
const completionLines = (lines: VisibleLine[]): string[] =>
  lines
    .filter(
      (line) =>
        line.kind !== "fullOutputNotice" &&
        line.text.trim() !== "" &&
        !line.text.trimStart().startsWith("tmux: "),
    )
    .map(shownText);

const clip = (text: string, maxLength: number): string =>
  text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;

const callCommand = (args: Partial<BashInput>): string =>
  clip((args.command ?? "...").replace(/\s+/g, " ").trim(), 80);

const backgroundTag = (args: Partial<BashInput>): string => {
  const poll = args.pollInterval !== undefined && args.pollInterval > 0 ? `, poll ${args.pollInterval}s` : "";
  return `(background${poll})`;
};

const callTags = (args: Partial<BashInput>): string[] => {
  // The run_in_background alias launches into the background exactly like
  // background:true — its call row must say so, not show a timeout tag.
  if (args.background === true || args.run_in_background === true) return [backgroundTag(args)];
  const timeout = args.timeout !== undefined ? [`(timeout ${args.timeout}s)`] : [];
  return timeout;
};

export const formatRenderedBashCall = (args: Partial<BashInput>): string =>
  [`$ ${callCommand(args)}`, ...callTags(args)].join(" ");

export const renderBashCallText = (args: Partial<BashInput>, theme: RenderTheme): string =>
  `${theme.fg("toolTitle", theme.bold(`$ ${callCommand(args)}`))}${callTags(args)
    .map((tag) => theme.fg("muted", ` ${tag}`))
    .join("")}`;

const contentLines = (details: BashOutputRenderDetails): BashOutputRenderLine[] =>
  dropTrailingBlanks(
    details.lines.filter((line) => line.kind === "output").map((line) => line.text),
  ).map((text) => ({ kind: "output", text }));

const noticeLines = (details: BashOutputRenderDetails, expanded: boolean): BashOutputRenderLine[] =>
  details.lines.filter(
    (line) => line.kind === "truncationNotice" || (expanded && line.kind === "fullOutputNotice"),
  );

const collapsedElision = (earlierLines: number): VisibleLine => {
  const key = keyText("app.tools.expand");
  return {
    kind: "collapsedElision",
    text: `... (${earlierLines} earlier lines, ${key} to expand)`,
    prefix: `... (${earlierLines} earlier lines,`,
    key,
    suffix: " to expand",
  };
};

const expandedElision = (earlierLines: number): VisibleLine => ({
  kind: "expandedElision",
  text: `... (${earlierLines} earlier lines omitted)`,
});

const visibleCount = (
  details: BashOutputRenderDetails,
  { expanded, compactDisplayLines = DEFAULT_OPTIONS.bashCompactDisplayLines,
    expandedDisplayLines = DEFAULT_OPTIONS.bashExpandedDisplayLines,
    truncatedCompactDisplayLines = compactDisplayLines }: LineBudget,
): number => {
  const collapsed = details.lines.some((line) => line.kind === "truncationNotice")
    ? truncatedCompactDisplayLines
    : compactDisplayLines;
  return expanded ? expandedDisplayLines : collapsed;
};

const visibleLines = (details: BashOutputRenderDetails, budget: LineBudget): VisibleLine[] => {
  const lines = contentLines(details);
  const count = visibleCount(details, budget);
  const notices = noticeLines(details, budget.expanded);
  const tailedNotices: BashOutputRenderLine[] =
    notices.length > 0 ? [{ kind: "output", text: "" }, ...notices] : [];
  if (lines.length <= count) return [...lines, ...tailedNotices];
  const shown = lines.slice(-count);
  const earlier = Math.max(0, lines.length - shown.length);
  return [
    budget.expanded ? expandedElision(earlier) : collapsedElision(earlier),
    ...shown,
    ...tailedNotices,
  ];
};

export const formatRenderedBashResult = (
  details: BashOutputRenderDetails,
  budget: LineBudget,
): string => visibleLines(details, budget).map((line) => line.text).join("\n").trimEnd();

const paintLine = (line: VisibleLine, theme: RenderTheme): string => {
  if (line.kind === "collapsedElision") {
    return (
      theme.fg("muted", line.prefix) + ` ${theme.fg("dim", line.key)}${theme.fg("muted", line.suffix)})`
    );
  }
  if (line.kind === "expandedElision") return theme.fg("muted", line.text);
  if (line.kind === "fullOutputNotice") return theme.fg("warning", line.text);
  return theme.fg("toolOutput", line.text);
};

const paintLines = (lines: VisibleLine[], theme: RenderTheme): string =>
  lines.map((line) => paintLine(line, theme)).join("\n");

const secondsOf = (ms: number): number => Math.max(0, ms / 1000);

export const formatDurationSeconds = (ms: number): string => `${Math.floor(secondsOf(ms))}s`;

const elapsedText = (ms: number): string => `${secondsOf(ms).toFixed(1)}s`;

const durationText = (state: TimingState, isPartial: boolean): string | undefined => {
  if (state.startedAt === undefined) return undefined;
  const end = state.endedAt ?? Date.now();
  return `${isPartial ? "Elapsed" : "Took"} ${elapsedText(end - state.startedAt)}`;
};

const foregroundBudget = (expanded: boolean, options: ResolvedOptions): LineBudget => ({
  expanded,
  compactDisplayLines: options.bashCompactDisplayLines,
  expandedDisplayLines: options.bashExpandedDisplayLines,
  truncatedCompactDisplayLines: options.bashTruncatedCompactDisplayLines,
});

const completionBudget = (expanded: boolean, options: ResolvedOptions): LineBudget => ({
  expanded,
  compactDisplayLines: expanded
    ? options.completedExpandedDisplayLines
    : options.completedCompactDisplayLines,
  expandedDisplayLines: options.completedExpandedDisplayLines,
  truncatedCompactDisplayLines: options.completedTruncatedCompactDisplayLines,
});

const pollBudget = (expanded: boolean, displayLines: number, options: ResolvedOptions): LineBudget => ({
  expanded,
  compactDisplayLines: displayLines,
  expandedDisplayLines: displayLines,
  truncatedCompactDisplayLines: options.pollTruncatedCompactDisplayLines,
});

const backgroundLines = (
  raw: string,
  details: BashOutputRenderDetails | undefined,
  expanded: boolean,
  options: ResolvedOptions,
): VisibleLine[] =>
  visibleLines(details ?? detailsOf(raw), foregroundBudget(expanded, options));

export const renderBackgroundBashResultText = ({
  raw,
  details,
  expanded,
  theme,
  options = DEFAULT_OPTIONS,
}: BackgroundResultOptions): string => {
  const painted = paintLines(backgroundLines(raw, details, expanded, options), theme);
  return painted ? `\n${painted}` : "";
};

export const renderBashResultText = ({
  raw,
  details,
  expanded,
  isPartial,
  state,
  theme,
  options = DEFAULT_OPTIONS,
}: BackgroundResultOptions & { isPartial: boolean; state: TimingState }): string => {
  const painted = paintLines(backgroundLines(raw, details, expanded, options), theme);
  const timing = durationText(state, isPartial);
  const paintedTiming = timing ? theme.fg("muted", timing) : "";
  if (!painted) return isPartial ? `\n${paintedTiming}` : paintedTiming;
  return [painted, paintedTiming].filter(Boolean).join(BASH_DURATION_SEPARATOR);
};

/**
 * Drop the appended truncation footer on terminal renders (the warning
 * covers it). Keyed on structured truncation state — the footer is always
 * the last block by construction of formatOutput — never on sniffing the
 * output text for brackets or paths.
 */
const withoutDuplicatedFooter = (
  output: string,
  details: TmuxBashToolDetails | undefined,
  isPartial: boolean,
): string => {
  if (isPartial || !details?.truncation?.truncated || !details.fullOutputPath) {
    return output;
  }
  const footerStart = output.lastIndexOf("\n\n[");
  if (footerStart === -1) return output;
  return output.slice(0, footerStart).trimEnd();
};

const foregroundWarning = (details: TmuxBashToolDetails | undefined): string | undefined => {
  const warnings: string[] = [];
  const truncation = details?.truncation;
  if (details?.fullOutputPath) warnings.push(`Full output: ${details.fullOutputPath}`);
  if (truncation?.truncated && truncation.truncatedBy === "lines") {
    warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
  }
  if (truncation?.truncated && truncation.truncatedBy !== "lines") {
    warnings.push(
      `Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
    );
  }
  return warnings.length > 0 ? `[${warnings.join(". ")}]` : undefined;
};

class ResultBox extends Container {}

class OutputPreview implements Component {
  private width: number | undefined;
  private lines: string[] | undefined;
  private skipped: number | undefined;

  constructor(
    private readonly output: string,
    private readonly theme: RenderTheme,
  ) {}

  render(width: number): string[] {
    if (this.lines === undefined || this.width !== width) {
      const preview = truncateToVisualLines(this.output, 5, width);
      this.lines = preview.visualLines;
      this.skipped = preview.skippedCount;
      this.width = width;
    }
    if (this.skipped && this.skipped > 0) {
      const hint =
        this.theme.fg("muted", `... (${this.skipped} earlier lines,`) +
        ` ${keyHint("app.tools.expand", "to expand")})`;
      return ["", truncateToWidth(hint, width, "..."), ...(this.lines ?? [])];
    }
    return ["", ...(this.lines ?? [])];
  }

  invalidate(): void {
    this.width = undefined;
    this.lines = undefined;
    this.skipped = undefined;
  }
}

export const renderForegroundBashResultComponent = ({
  raw,
  details,
  expanded,
  isPartial,
  state,
  theme,
}: ForegroundResultOptions): Component => {
  const box = new ResultBox();
  const output = withoutDuplicatedFooter(raw.trim(), details, isPartial);
  const timing = durationText(state, isPartial);
  const warning = foregroundWarning(details);

  if (output) {
    const painted = output
      .split("\n")
      .map((line) => theme.fg("toolOutput", line))
      .join("\n");
    box.addChild(expanded ? new Text(`\n${painted}`, 0, 0) : new OutputPreview(painted, theme));
  }
  if (warning) box.addChild(new Text(`\n${theme.fg("warning", warning)}`, 0, 0));
  if (timing) box.addChild(new Text(`\n${theme.fg("muted", timing)}`, 0, 0));
  return box;
};

export const hasOnlyEmptyBashOutput = (details: BashOutputRenderDetails): boolean =>
  details.empty && details.lines.every((line) => line.kind === "output");

export const formatRenderedCompletionMessage = ({
  details,
  expanded,
  options = DEFAULT_OPTIONS,
}: {
  details: CompletionMessageRenderDetails;
  expanded: boolean;
  options?: ResolvedOptions;
}): string => {
  if (hasOnlyEmptyBashOutput(details.output)) return details.summary;
  if (expanded) {
    const lines = visibleLines(details.output, completionBudget(true, options))
      .map(shownText)
      .slice(-options.completedExpandedDisplayLines);
    return [details.summary, ...indentDisplayLines(lines)].join("\n");
  }
  const lines = completionLines(visibleLines(details.output, completionBudget(false, options)));
  if (lines.length === 0) return details.summary;
  return [details.summary, "", ...indentDisplayLines(lines)].join("\n");
};

export const formatRenderedPollMessage = ({
  details,
  expanded,
  options = DEFAULT_OPTIONS,
}: {
  details: PollMessageRenderDetails;
  expanded: boolean;
  options?: ResolvedOptions;
}): string => {
  const perSide = expanded ? options.pollExpandedDisplayLines : options.pollCompactDisplayLines;
  const compacted = formatRenderedBashResult(details.output, pollBudget(expanded, perSide, options));
  const body = [...(details.command ? [details.command] : []), ...(compacted ? compacted.split("\n") : [])];
  const rendered = [details.summary, indentDisplayLines(body).join("\n")].filter(Boolean).join("\n\n");
  return details.attachLines.length > 0 ? `${rendered}\n\n${details.attachLines.join("\n")}` : rendered;
};
