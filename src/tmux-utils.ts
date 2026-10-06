import { execSync } from "node:child_process";
import { DEFAULT_OPTIONS, SHELL_IDENTIFIER_REGEX, type ResolvedOptions } from "./config";

/** Run a shell command, returning trimmed stdout or null on any failure. */
export const execSafe = (cmd: string): string | null => {
  try {
    return execSync(cmd, { encoding: "utf-8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
};

/** Single-quote a value for safe embedding in a shell command line. */
export const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/** Names that may be exported into a tmux-spawned shell environment. */
const isExportableName = (name: string, denylist: ReadonlySet<string>): boolean =>
  SHELL_IDENTIFIER_REGEX.test(name) && !denylist.has(name);

/** `export NAME='value'` lines for the current process environment. */
export const formatEnvironmentExportsForBash = (
  env: NodeJS.ProcessEnv = process.env,
  denylist: readonly string[] = DEFAULT_OPTIONS.tmuxEnvExportDenylist,
): string => {
  const denied = new Set(denylist);
  return Object.entries(env)
    .filter(([name, value]) => value !== undefined && isExportableName(name, denied))
    .map(([name, value]) => `export ${name}=${shellQuote(value ?? "")}`)
    .join("\n");
};

export type TmuxWindow = {
  id: string;
  index: number;
  title: string;
  active: boolean;
  createdAt?: number;
  gitRoot?: string;
  piSessionId?: string;
  outputFile?: string;
  displayCommand?: string;
  jobId?: string;
};

export type TmuxWindowFilters = {
  gitRoot?: string;
  piSessionId?: string;
};

/** tmux user options carrying our per-window bookkeeping. */
export const TMUX_WINDOW_OPTIONS = {
  startedAt: "@pi-tmux-bash-started-at",
  gitRoot: "@pi-tmux-bash-git-root",
  piSessionId: "@pi-tmux-bash-pi-session-id",
  outputFile: "@pi-tmux-bash-output-file",
  displayCommand: "@pi-tmux-bash-display-command",
  jobId: "@pi-tmux-bash-job-id",
} as const;

/** Wrap a tmux option name as a `#{...}` format expansion. */
export const tmuxFormatOption = (option: string): string => `#{${option}}`;

const LIST_FIELDS = [
  "#{window_id}",
  "#{window_index}",
  "#{window_name}",
  "#{window_active}",
  tmuxFormatOption(TMUX_WINDOW_OPTIONS.startedAt),
  tmuxFormatOption(TMUX_WINDOW_OPTIONS.gitRoot),
  tmuxFormatOption(TMUX_WINDOW_OPTIONS.piSessionId),
  tmuxFormatOption(TMUX_WINDOW_OPTIONS.outputFile),
  tmuxFormatOption(TMUX_WINDOW_OPTIONS.displayCommand),
  tmuxFormatOption(TMUX_WINDOW_OPTIONS.jobId),
].join("|||");

const matchesFilters = (window: TmuxWindow, filters: TmuxWindowFilters): boolean =>
  (filters.gitRoot === undefined || window.gitRoot === filters.gitRoot) &&
  (filters.piSessionId === undefined || window.piSessionId === filters.piSessionId);

const parseWindowLine = (line: string): TmuxWindow => {
  const [
    id = "",
    index = "0",
    title = "",
    active = "0",
    createdAt = "",
    gitRoot = "",
    piSessionId = "",
    outputFile = "",
    displayCommand = "",
    jobId = "",
  ] = line.split("|||");
  const window: TmuxWindow = { id, index: parseInt(index), title, active: active === "1" };
  if (createdAt) window.createdAt = parseInt(createdAt);
  if (gitRoot) window.gitRoot = gitRoot;
  if (piSessionId) window.piSessionId = piSessionId;
  if (outputFile) window.outputFile = outputFile;
  if (displayCommand) window.displayCommand = displayCommand;
  if (jobId) window.jobId = jobId;
  return window;
};

/** List windows of a session on the given tmux binary (default server). */
export const getWindows = (
  sessionName: string,
  filters?: TmuxWindowFilters,
  tmuxBinary = "tmux",
): TmuxWindow[] => {
  const raw = execSafe(
    `${shellQuote(tmuxBinary)} list-windows -t ${shellQuote(sessionName)} -F ${shellQuote(LIST_FIELDS)}`,
  );
  if (!raw) return [];
  const active = filters ?? {};
  return raw
    .split("\n")
    .map(parseWindowLine)
    .filter((window) => matchesFilters(window, active));
};

const tmuxBase = (tmuxBinary: string, socketName?: string): string => {
  const binary = tmuxBinary === "tmux" ? "tmux" : shellQuote(tmuxBinary);
  return socketName ? `${binary} -L ${socketName}` : binary;
};

/** The shell command that attaches the user's terminal to a window. */
export const tmuxWindowAttachCommand = (
  windowId: string,
  env: NodeJS.ProcessEnv,
  tmuxBinary: string,
  socketName?: string,
): string => {
  const base = tmuxBase(tmuxBinary, socketName);
  return env.TMUX ? `${base} switch-client -t ${windowId}` : `${base} attach -t ${windowId}`;
};

/** One-line hint telling the model how to attach to a window. */
export const tmuxWindowAttachHint = (
  windowId: string,
  env: NodeJS.ProcessEnv,
  tmuxBinary: string,
  socketName?: string,
): string => `Attach with: ${tmuxWindowAttachCommand(windowId, env, tmuxBinary, socketName)}`;
