import { defineZodToolCall } from "./tool-call";
import { z } from "zod";
import type { TmuxAction } from "./config";

type SchemaOptions = {
  bashToolName: string;
  tmuxToolName: string;
  defaultTimeoutSeconds: number;
  defaultTimeoutAction: "kill" | "background" | "ask";
  maxTimeoutSeconds: number;
  defaultPollInterval: number;
  pollContextLines: number;
  tmuxEnabledActions: readonly TmuxAction[];
  bashPollIntervalEnabled: boolean;
};

type InvalidInput<TInvalidResult> = (message: string) => TInvalidResult;

export type BashInput =
  | {
      command: string;
      name?: string;
      background: true;
      run_in_background?: boolean;
      timeout: number;
      timeoutAction?: "kill" | "background" | "ask";
      pollInterval?: number;
      pollLines?: number;
    }
  | {
      command: string;
      name?: string;
      background?: false;
      run_in_background?: boolean;
      timeout: number;
      timeoutAction: "kill" | "background" | "ask";
      pollInterval?: number;
      pollLines?: number;
    };

export type TmuxInput =
  | { action: "list" }
  | { action: "kill"; window: string }
  | { action: "peek"; window: string };

const commandField = z.string().min(1).describe("Bash command to execute.");
const nameField = z.string().optional().describe("Optional tmux window name.");
const aliasField = z
  .boolean()
  .optional()
  .describe("Claude-Code-compatible alias for background: return immediately, keep running.");

/** tmux #{window_id} (e.g. @123) or bg-shell job_id (e.g. a1b2c3). */
const windowField = z
  .string()
  .regex(/^(@\d+|[0-9a-f]{6})$/)
  .describe("tmux #{window_id} (e.g. @123) or bg-shell job_id (e.g. a1b2c3).");

const timeoutField = (options: SchemaOptions) =>
  z
    .number()
    .int()
    .positive()
    .max(options.maxTimeoutSeconds)
    .default(options.defaultTimeoutSeconds)
    .describe(
      "Foreground wait in seconds before timeoutAction. NOT an execution limit: " +
        'with timeoutAction "background" the command keeps running after this deadline.',
    );

const checkinField = (options: SchemaOptions) =>
  z
    .number()
    .int()
    .nonnegative()
    .default(options.defaultPollInterval)
    .describe("Seconds between background check-ins.");

const linesField = (options: SchemaOptions) =>
  z
    .number()
    .int()
    .positive()
    .default(options.pollContextLines)
    .describe("Lines captured per check-in.");

/** Extra poll fields, present only when interval check-ins are enabled. */
const checkinFields = (options: SchemaOptions) =>
  options.bashPollIntervalEnabled
    ? { pollInterval: checkinField(options), pollLines: linesField(options) }
    : {};

const buildBashInputSchema = (options: SchemaOptions): z.ZodType<BashInput> => {
  const extra = checkinFields(options);
  const shared = {
    command: commandField,
    name: nameField,
    run_in_background: aliasField,
    timeout: timeoutField(options),
  };
  // Two explicit variants (not a nested union): friendlier to strict providers.
  return z.union([
    z.object({
      ...shared,
      background: z
        .literal(true)
        .describe(
          "Return immediately and keep running in tmux. timeout/timeoutAction are ignored on background launches (only pollInterval applies).",
        ),
      timeoutAction: z
        .enum(["kill", "background", "ask"])
        .optional()
        .describe('"kill", "background", or "ask" (you decide) on timeout.'),
      ...extra,
    }),
    z.object({
      ...shared,
      background: z.literal(false).optional(),
      timeoutAction: z
        .enum(["kill", "background", "ask"])
        .default(options.defaultTimeoutAction)
        .describe('"kill" or "background" on timeout, or "ask" to decide yourself when it fires.'),
      ...extra,
    }),
  ]) as unknown as z.ZodType<BashInput>;
};

const buildTmuxInputSchema = (options: SchemaOptions): z.ZodType<TmuxInput> => {
  const variants = {
    list: z.object({ action: z.literal("list").describe("tmux action.") }),
    kill: z.object({
      action: z.literal("kill").describe("tmux action."),
      window: windowField,
    }),
    peek: z.object({
      action: z.literal("peek").describe("tmux action."),
      window: windowField,
    }),
  };
  const enabled = options.tmuxEnabledActions.map((action) => variants[action]);
  const [first, ...rest] = enabled;
  if (!first) return z.never() as z.ZodType<TmuxInput>;
  if (rest.length === 0) return first as z.ZodType<TmuxInput>;
  return z.discriminatedUnion("action", [first, ...rest]) as z.ZodType<TmuxInput>;
};

export const buildBashToolCallSchema = <TInvalidResult>(
  options: SchemaOptions,
  invalidInput: InvalidInput<TInvalidResult>,
) =>
  defineZodToolCall({
    toolName: options.bashToolName,
    zodSchema: buildBashInputSchema(options),
    invalidInput,
  });

export const buildTmuxToolCallSchema = <TInvalidResult>(
  options: SchemaOptions,
  invalidInput: InvalidInput<TInvalidResult>,
) =>
  defineZodToolCall({
    toolName: options.tmuxToolName,
    zodSchema: buildTmuxInputSchema(options),
    invalidInput,
  });
