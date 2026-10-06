import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ResolvedOptions } from "../config";
import {
  renderPromptTemplate,
  resolveSystemPromptToolSnippet,
  systemPromptGuidelines,
} from "../system-prompt";
import { toolError } from "../runtime";
import type { ExtensionState } from "../engine/types";
import { runBashJob } from "../engine/wiring";
import {
  renderBackgroundBashResultText,
  renderBashCallText,
  renderForegroundBashResultComponent,
  type TmuxBashToolDetails,
} from "../render";
import { buildBashToolCallSchema, type BashInput } from "../tool-call-schemas";

export type BashRenderState = {
  startedAt?: number;
  endedAt?: number;
  interval?: NodeJS.Timeout;
};

type RenderContext = {
  args: Partial<BashInput>;
  state: BashRenderState;
  executionStarted: boolean;
  isError: boolean;
  invalidate: () => void;
};

const asContext = (context: unknown): RenderContext => context as RenderContext;

/** Start the wall-clock timer on first call render. */
const beginTiming = (context: RenderContext): void => {
  if (!context.executionStarted || context.state.startedAt !== undefined) return;
  context.state.startedAt = Date.now();
  context.state.endedAt = undefined;
};

/** Tick the timer while partial, settle it on the terminal render. */
const advanceTiming = (context: RenderContext, isPartial: boolean): void => {
  if (context.state.startedAt === undefined) context.state.startedAt = Date.now();
  if (isPartial && !context.state.interval) {
    context.state.interval = setInterval(() => context.invalidate(), 1000);
  }
  if (isPartial && !context.isError) return;
  if (context.state.endedAt === undefined) context.state.endedAt = Date.now();
  if (!context.state.interval) return;
  clearInterval(context.state.interval);
  context.state.interval = undefined;
};

/** Duration chrome only for foreground calls still owned by their call row. */
const ownsDuration = (
  args: Partial<BashInput>,
  details: TmuxBashToolDetails | undefined,
): boolean =>
  args.background !== true && args.run_in_background !== true && details?.outcome === undefined;

export const registerBashTool = (
  pi: ExtensionAPI,
  state: ExtensionState,
  options: ResolvedOptions,
): void => {
  const schema = buildBashToolCallSchema(options, toolError);

  pi.registerTool({
    name: options.bashToolName,
    label: options.bashToolName,
    description: renderPromptTemplate(options.bashToolDescription, options),
    promptSnippet: resolveSystemPromptToolSnippet(options.bashSystemPromptSnippet, options),
    promptGuidelines: systemPromptGuidelines(options),
    parameters: schema.typeBoxSchema,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return schema.handleInput(params, (input) =>
        runBashJob(input, toolCallId, signal, onUpdate, pi, ctx, state, options),
      );
    },
    renderCall(args, theme, context) {
      const ctx = asContext(context);
      beginTiming(ctx);
      const callArgs = args as Partial<BashInput>;
      const detachable =
        callArgs.background !== true &&
        callArgs.run_in_background !== true &&
        options.detachShortcut !== false;
      const hint = detachable ? theme.fg("muted", ` (${options.detachShortcut} to background)`) : "";
      return new Text(renderBashCallText(callArgs, theme) + hint, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      const ctx = asContext(context);
      const content = result.content?.[0];
      const raw = content?.type === "text" ? content.text : "";
      const details = result.details as TmuxBashToolDetails | undefined;

      if (!ownsDuration(ctx.args, details)) {
        const render = details?.outcome !== undefined ? undefined : details?.render;
        return new Text(
          renderBackgroundBashResultText({ raw, details: render, expanded, theme, options }),
          0,
          0,
        );
      }
      advanceTiming(ctx, isPartial);
      return renderForegroundBashResultComponent({
        raw,
        details,
        expanded,
        isPartial,
        state: ctx.state,
        theme,
        options,
      });
    },
  });
};
