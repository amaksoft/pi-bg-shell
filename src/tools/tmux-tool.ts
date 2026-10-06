import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ResolvedOptions } from "../config";
import {
  renderPromptTemplate,
  resolveSystemPromptToolSnippet,
  systemPromptGuidelines,
} from "../system-prompt";
import { executeTool, toolError } from "../runtime";
import type { ExtensionState } from "../engine/types";
import { buildTmuxToolCallSchema } from "../tool-call-schemas";

type TmuxTheme = {
  fg: (name: "success" | "dim", text: string) => string;
};

type RenderBlocks = {
  summary: string;
  expandedLines: string[];
  collapsedLines: string[];
  attachLines?: string[];
};

/** Actions that address a specific window (shown in the call row). */
const TARGETED_ACTIONS = ["peek", "kill"];

const windowSuffix = (action: string, window: number | string | undefined): string => {
  if (!TARGETED_ACTIONS.includes(action) || window === undefined) return "";
  const target = String(window);
  return target.startsWith("@") ? ` ${target}` : ` :${target}`;
};

const asStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const renderBlocksOf = (details: unknown): RenderBlocks | undefined => {
  if (!details || typeof details !== "object") return undefined;
  const render = (details as { render?: Partial<RenderBlocks> }).render;
  if (typeof render?.summary !== "string") return undefined;
  if (!asStringList(render.expandedLines) || !asStringList(render.collapsedLines)) return undefined;
  if (render.attachLines !== undefined && !asStringList(render.attachLines)) return undefined;
  return {
    summary: render.summary,
    expandedLines: render.expandedLines,
    collapsedLines: render.collapsedLines,
    attachLines: render.attachLines,
  };
};

const renderTextOf = (render: RenderBlocks, expanded: boolean, theme: TmuxTheme): string =>
  [
    `${theme.fg("success", "✓ ")}${render.summary}`,
    ...(expanded ? render.expandedLines : render.collapsedLines),
    ...(render.attachLines ?? []),
  ].join("\n");

export const registerTmuxTool = (
  pi: ExtensionAPI,
  state: ExtensionState,
  options: ResolvedOptions,
): void => {
  const schema = buildTmuxToolCallSchema(options, toolError);
  // The `bg` alias gives models a familiar management name; same backend.
  const names = [...new Set([options.tmuxToolName, options.bgToolName])];

  for (const toolName of names) {
    const primary = toolName === options.tmuxToolName;
    pi.registerTool({
      name: toolName,
      label: toolName,
      description: renderPromptTemplate(
        primary ? options.tmuxToolDescription : options.bgToolDescription,
        options,
      ),
      // Pure alias: one backend, one copy of guidelines in context.
      promptSnippet: primary
        ? resolveSystemPromptToolSnippet(options.tmuxSystemPromptSnippet, options)
        : undefined,
      promptGuidelines: primary ? systemPromptGuidelines(options) : [],
      parameters: schema.typeBoxSchema,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        return schema.handleInput(params, (input) => executeTool(input, ctx, state, pi, options));
      },
      renderCall(args, theme) {
        const call = args as Partial<{ action: string; window: number | string }>;
        const action = call.action ?? toolName;
        return new Text(
          `${theme.fg("toolTitle", theme.bold(`${toolName} `))}${theme.fg("accent", action)}${theme.fg("muted", windowSuffix(action, call.window))}`,
          0,
          0,
        );
      },
      renderResult(result, { expanded }, theme) {
        const render = renderBlocksOf(result.details);
        // Degrade to raw text: never crash the transcript on reshaped details.
        if (!render) {
          const content = result.content?.[0];
          const raw = content?.type === "text" ? content.text : "Background task update";
          return new Text(raw, 0, 0);
        }
        return new Text(renderTextOf(render, expanded, theme), 0, 0);
      },
    });
  }
};
