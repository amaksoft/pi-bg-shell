/**
 * Single verdict/display grammar for background-job surfaces (Phase 4).
 * Pure data: every function takes plain values and returns plain strings or
 * tone-tagged segments. Renderers (engine messages, widget, overlay, fork
 * chrome) map tones to their own theme — the DECISIONS (what text, what
 * counts, when hints show) live here exactly once.
 *
 * Zero imports by construction (see the no-TUI-in-core test).
 */

export type Tone = "success" | "error" | "muted" | "dim";

export type Segment = {
  text: string;
  tone: Tone;
};

/** Branch lead/indent geometry shared by all renderers (they wrap in theme). */
export const BRANCH_LEAD = "  ⎿  ";
export const branchIndent = (text: string): string => `${" ".repeat(BRANCH_LEAD.length)}${text}`;

/** Split content into branch lines: lead first, indented rest. */
export const branchLines = (content: string): string[] => {
  if (!content || !content.trim()) return [];
  const [first = "", ...rest] = content.split("\n");
  return [`${BRANCH_LEAD}${first}`, ...rest.map(branchIndent)];
};

/** Content lines (claudify parity: blank lines carry no content). */
export const nonBlankLines = (texts: string[]): string[] =>
  texts.filter((text) => text.trim().length > 0);

/** Tail window: last N lines (elision point for previews). */
export const tailWindow = (lines: string[], budget: number): string[] => lines.slice(-budget);

/**
 * Collapsed aggregate summary (greyed substitution carrying the display
 * name): `Ran 1 shell command: <name>` / `Ran N shell commands`.
 */
export const singleSummary = (name: string, jobId?: string): string =>
  `Ran 1 shell command: ${name}${jobId ? ` · job ${jobId}` : ""}`;

export const batchSummary = (count: number): string => `Ran ${count} shell commands`;

/** Claudify-exact verdict: `Done (N lines)` / `Exit N` (N = content lines). */
export const verdictSegments = (exitCode: number, lineCount: number): Segment[] =>
  exitCode === 0
    ? [
        { text: "Done", tone: "success" },
        { text: ` (${lineCount} lines)`, tone: "muted" },
      ]
    : [{ text: `Exit ${exitCode}`, tone: "error" }];

/** Claudify-exact collapsed hint: muted, keyboard-only, no click text. */
export const expandHintSegments = (): Segment[] => [{ text: " (ctrl+o to expand)", tone: "muted" }];

/** Display-name fallback chain (given name > short command > shell). */
export const displayNameOf = (command?: string, displayName?: string): string =>
  displayName ?? command?.split("\n")[0].slice(0, 60) ?? "shell";

/** Max verbatim command length before falling back to the derived label. */
export const DISPLAY_COMMAND_LIMIT = 60;

// Parse from the right so tmux session names can contain dots.
/**
 * Derived short label for a command: first meaningful pipeline segment
 * (skipping `cd` setups), binary basename + first args, durations humanized.
 * Used only when the command itself is too long to show.
 */
export const nameJobForCommand = (command: string): string => {
  const segments = command
    .split(/&&|\|\||;|\|/)
    .map((part) => part.trim())
    .filter(Boolean);
  const segment = segments.find((part) => !/^cd(\s|$)/.test(part)) ?? segments[0] ?? "";
  const parts = segment.split(/\s+/).filter(Boolean);
  const bin = parts[0]?.split("/").pop() ?? "";
  if (!bin) return "shell";
  if (bin === "sleep" && parts[1]) return `sleep ${parts[1]}s`;
  const label = parts.length > 1 ? `${bin} ${parts.slice(1, 3).join(" ")}` : bin;
  return label.length > 40 ? `${label.slice(0, 39)}…` : label;
};

/**
 * Display priority: given name > short command verbatim (≤60 chars) >
 * derived label. The single job-naming policy: footer, /tasks, widget,
 * and grouped summaries agree by construction.
 */
export const resolveDisplayName = (command: string, givenName?: string): string => {
  if (givenName && givenName.trim().length > 0) return givenName.trim();
  const firstLine = command.split("\n")[0].trim();
  if (firstLine.length > 0 && firstLine.length <= DISPLAY_COMMAND_LIMIT) return firstLine;
  return nameJobForCommand(command);
};

/** Human age (`45s`, `3m`, `2h`) shared by footer, widget, and overlays. */
export const formatAge = (ms: number): string => {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
};

/** Unread marker per surface (`/tasks` text list vs overlay labels). */
export const unreadMark = (surface: "text" | "overlay"): string =>
  surface === "text" ? ", unread" : " · unread";

/** Finished widget row: `✓/✗ cmd · exit N · age` (ok rows dim, failed red). */
export const finishedRowSegments = (command: string, exitCode: number, ageText: string): Segment[] => [
  {
    text: `${exitCode === 0 ? "✓" : "✗"} ${command.split("\n")[0].slice(0, 40)} · exit ${exitCode} · ${ageText}`,
    tone: exitCode === 0 ? "dim" : "error",
  },
];

/** Overflow pointer: `+N more (see /tasks)`. */
export const overflowSegments = (hidden: number): Segment[] => [
  { text: `+${hidden} more (see /tasks)`, tone: "dim" },
];

/** Overlay row label: `cmd · id · age` plus the unread flag. */
export const overlayRowLabel = (
  displayCmd: string,
  jobId: string,
  ageText: string,
  flags: { unread?: boolean },
): string =>
  `${displayCmd} · ${jobId} · ${ageText}${flags.unread ? unreadMark("overlay") : ""}`;

/** Text-list row: `  cmd60 window` plus the unread flag. */
export const textRowLabel = (
  command: string,
  windowId: string,
  flags: { unread?: boolean },
): string =>
  `  ${command.split("\n")[0].slice(0, 60)} ${windowId}${flags.unread ? unreadMark("text") : ""}`;
