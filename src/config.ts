import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { loadConfigOrDefault, templatedString } from "./config-file";
import { z } from "zod";

/** Status-bar slot carrying the background-job summary line. */
export const BACKGROUND_BASH_STATUS_KEY = "backgroundBashTmuxCommands";
export const BASH_DURATION_SEPARATOR = "\n\n";
/** Valid shell identifier characters for environment export filtering. */
export const SHELL_IDENTIFIER_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Shell bookkeeping that must not leak into the new tmux window. */
const DEFAULT_ENV_DENYLIST = ["PWD", "OLDPWD", "SHLVL", "_", "TMUX", "TMUX_PANE"] as const;

/**
 * Default spool root: XDG state dir when set, else ~/.local/share, else the
 * OS tmpdir. Explicit `outputDir` always wins (state-spool override).
 */
export const defaultOutputDir = (): string => {
  const base =
    process.env.XDG_STATE_HOME || join(homedir(), ".local", "share") || tmpdir();
  return join(base, "pi-bg-shell");
};

const DEFAULT_BASH_SNIPPET = "Execute bash commands in background tmux windows";
const DEFAULT_TMUX_SNIPPET = "Inspect and control the background tmux sessions created by bash tool";
const DEFAULT_BASH_DESCRIPTION =
  'Execute a bash command in a background tmux window. Output is truncated to last {{bashContextLines}} lines or {{maxOutputKb}}KB. Defaults to a {{defaultTimeoutSeconds}}s timeout, max {{maxTimeoutSeconds}}s; timeoutAction defaults to "{{defaultTimeoutAction}}". Use background for long-running commands. Pass name (a short human label, e.g. "auth tests") for background runs — it shows in the footer, /tasks, and job widget.';
const DEFAULT_TMUX_DESCRIPTION =
  "Inspect and control background tmux windows created by bash. Peek output is compact by default.";
const DEFAULT_BG_DESCRIPTION =
  "Manage background shell jobs: list them, peek at output, or stop one by job_id. Same backend as {{tmuxToolName}}.";
const DEFAULT_PEEK_EXPANDED_LINES = 50;

export const TMUX_ACTIONS = ["list", "peek", "kill"] as const;
const DEFAULT_ENABLED_ACTIONS = ["list", "peek", "kill"] as const;

const DEFAULT_GUIDELINES = [
  'Use {{bashToolName}} with background: true (or run_in_background: true) or timeoutAction: "background" for long-running commands, servers, watchers, REPLs, interactive prompts, and background bash commands.',
  "Background bash commands return a job_id and log_path and report automatically when they finish; prefer waiting for the completion report over re-reading output, and use the log_path with Read only when you need interim output.",
  "Use {{tmuxToolName}} list to find background windows; {{tmuxToolName}} peek/kill take a job_id or a stable #{window_id} like @123.",
  "Background jobs do not survive pi shutdown: the default stop-all policy kills them without a completion report; the transcript plus spool logs are the history.",
  "If asked, you can attach to tmux window using: {{attachCommand}}, where @123 is a #{window_id}.",
];

const PROMPT_VARIABLES = [
  "attachCommand",
  "bashContextLines",
  "bashToolName",
  "defaultTimeoutAction",
  "defaultTimeoutSeconds",
  "maxOutputKb",
  "maxTimeoutSeconds",
  "tmuxToolName",
];

const timeoutsOrdered = (config: {
  defaultTimeoutSeconds?: number;
  maxTimeoutSeconds?: number;
}): boolean =>
  config.defaultTimeoutSeconds === undefined ||
  config.maxTimeoutSeconds === undefined ||
  config.defaultTimeoutSeconds <= config.maxTimeoutSeconds;

const nonEmptyString = z.string().trim().min(1);
const positiveInt = z.number().int().positive();

const promptTemplate = templatedString({ variables: PROMPT_VARIABLES, missing: "keep" }).trim().min(1);
const promptEntry = z.union([promptTemplate, z.literal(false)]);
const windowNameTemplate = templatedString({
  variables: ["command", "name", "nameOrCommand"],
  missing: "keep",
});

const buildOptionsSchema = () =>
  z
    .object({
      // Tool registration.
      bashToolName: nonEmptyString.default("bash"),
      tmuxToolName: nonEmptyString.default("tmux"),
      bgToolName: nonEmptyString.default("bg"),
      tmuxEnabledActions: z.array(z.enum(TMUX_ACTIONS)).default(() => [...DEFAULT_ENABLED_ACTIONS]),
      tmuxBinary: nonEmptyString.default("tmux"),
      bashToolDescription: promptTemplate.default(DEFAULT_BASH_DESCRIPTION),
      tmuxToolDescription: promptTemplate.default(DEFAULT_TMUX_DESCRIPTION),
      bgToolDescription: promptTemplate.default(DEFAULT_BG_DESCRIPTION),
      // Foreground/background behavior.
      bashPollIntervalEnabled: z.boolean().default(false),
      defaultTimeoutSeconds: positiveInt.default(30),
      // "ask" (model decides kill vs background at the deadline) is the
      // default: best of both worlds, no silent kills, no stray survivors.
      defaultTimeoutAction: z.enum(["kill", "background", "ask"]).default("ask"),
      // Generous: the timeout is a foreground-detach deadline, not an execution
      // limit, so capping it low only forces models to narrate the clamp.
      maxTimeoutSeconds: positiveInt.default(600),
      defaultPollInterval: z.number().int().nonnegative().default(0),
      pollDelivery: z.enum(["model", "display"]).default("model"),
      minimumPollIntervalSeconds: positiveInt.default(10),
      // Stall warnings: static log with an interactive-prompt tail reports
      // (patty-bg-tasks idea). 0 disables detection.
      stallPromptThresholdSeconds: z.number().int().nonnegative().default(120),
      foregroundBashUpdateIntervalMs: positiveInt.default(250),
      // Display budgets (lines).
      bashContextLines: positiveInt.default(DEFAULT_MAX_LINES),
      bashCompactDisplayLines: positiveInt.default(5),
      bashTruncatedCompactDisplayLines: positiveInt.default(2),
      bashExpandedDisplayLines: positiveInt.default(DEFAULT_MAX_LINES),
      completedContextLines: positiveInt.default(20),
      completedCompactDisplayLines: positiveInt.default(5),
      completedTruncatedCompactDisplayLines: positiveInt.default(2),
      completedExpandedDisplayLines: positiveInt.default(20),
      pollContextLines: positiveInt.default(30),
      pollCompactDisplayLines: positiveInt.default(5),
      pollTruncatedCompactDisplayLines: positiveInt.default(2),
      pollExpandedDisplayLines: positiveInt.default(30),
      peekContextLines: positiveInt.default(DEFAULT_MAX_LINES),
      peekCompactDisplayLines: positiveInt.default(5),
      peekTruncatedCompactDisplayLines: positiveInt.default(2),
      peekExpandedDisplayLines: positiveInt.default(DEFAULT_PEEK_EXPANDED_LINES),
      // Window naming + lifecycle.
      tmuxWindowNameTemplate: windowNameTemplate.default("{{nameOrCommand}}"),
      maxTmuxWindowNameLength: positiveInt.default(30),
      autoCloseWindowsOnCompletion: z.boolean().default(true),
      alwaysShowOutputFilePath: z.boolean().default(false),
      preserveOutputFiles: z.boolean().default(true),
      preservedOutputRetentionDays: z.number().int().nonnegative().default(7),
      maxPreservedOutputMb: z.number().int().nonnegative().default(256),
      shutdownPolicy: z.enum(["stop-all", "leave-running"]).default("stop-all"),
      // Glanceable jobs widget near the editor (pi-subagents parity).
      // False disables it; the setStatus line + /tasks overlay are unaffected.
      jobsWidget: z.union([z.enum(["belowEditor", "aboveEditor"]), z.literal(false)]).default("belowEditor"),
      // Plain-text message chrome: completion/poll messages render as
      // unstyled text (no expandable blocks), for minimal presents.
      plainChrome: z.boolean().default(false),
      // Owner-dead conjunction: heartbeat older than this + lock acquirable.
      ownerStaleAfterMs: positiveInt.default(300000),
      notifyOnCompletion: z.boolean().default(true),
      // No contextual-shortcut API exists in pi, so this key is claimed
      // globally while the extension loads (it shadows tui.editor.cursorLeft;
      // pi reports the conflict at startup). Set false to not claim any key.
      detachShortcut: z.union([nonEmptyString, z.literal(false)]).default("ctrl+b"),
      outputDir: nonEmptyString.default(defaultOutputDir()),
      displayCommandStartMarker: z.string().default("# SHIM_END"),
      maxOutputBytes: positiveInt.default(DEFAULT_MAX_BYTES),
      tmuxEnvExportDenylist: z.array(nonEmptyString).default(() => [...DEFAULT_ENV_DENYLIST]),
      // System prompt.
      systemPrompt: z.boolean().default(true),
      bashSystemPromptSnippet: promptEntry.default(DEFAULT_BASH_SNIPPET),
      tmuxSystemPromptSnippet: promptEntry.default(DEFAULT_TMUX_SNIPPET),
      systemPromptGuidelines: z.array(promptTemplate).default(() => [...DEFAULT_GUIDELINES]),
    })
    .refine(timeoutsOrdered, {
      message: "defaultTimeoutSeconds must be less than or equal to maxTimeoutSeconds",
    });

export const TmuxBashOptionsSchema = buildOptionsSchema();
export const TmuxBashConfigSchema = buildOptionsSchema();

type ParsedInput = z.input<typeof TmuxBashOptionsSchema>;
type ParsedOutput = z.output<typeof TmuxBashOptionsSchema>;

export type TmuxAction = (typeof TMUX_ACTIONS)[number];

export type TmuxBashOptions = Omit<ParsedInput, "tmuxEnabledActions" | "tmuxEnvExportDenylist"> & {
  tmuxEnabledActions?: readonly TmuxAction[];
  tmuxEnvExportDenylist?: readonly string[];
};

export type ResolvedOptions = Omit<ParsedOutput, "tmuxEnabledActions" | "tmuxEnvExportDenylist"> & {
  tmuxEnabledActions: readonly TmuxAction[];
  tmuxEnvExportDenylist: readonly string[];
};

export const DEFAULT_OPTIONS: ResolvedOptions = TmuxBashOptionsSchema.parse({});

export const resolveOptions = (input: TmuxBashOptions = {}): ResolvedOptions =>
  TmuxBashOptionsSchema.parse(input);

// Reads ~/.pi/agent/tmux-bash.jsonc with the same schema as the extension
// entrypoint, falling back to defaults for omitted keys. Useful when another
// extension wants to target the same background sessions.
export const loadTmuxBashConfig = (): ResolvedOptions =>
  resolveOptions(loadConfigOrDefault({ filename: "tmux-bash.jsonc", schema: TmuxBashConfigSchema }));
