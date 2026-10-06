import { tmuxWindowAttachCommand } from "./tmux-utils";
import type { ResolvedOptions } from "./config";

const fillVariable = (template: string, variable: string, value: string): string =>
  template.replace(new RegExp(`{{\\s*${variable}\\s*}}`, "g"), value);

/** Fill every known `{{variable}}` in a prompt template from options. */
export const renderPromptTemplate = (template: string, options: ResolvedOptions): string => {
  const values: Record<string, string> = {
    attachCommand: tmuxWindowAttachCommand("@123", process.env, options.tmuxBinary),
    bashContextLines: String(options.bashContextLines),
    bashToolName: options.bashToolName,
    defaultTimeoutAction: options.defaultTimeoutAction,
    defaultTimeoutSeconds: String(options.defaultTimeoutSeconds),
    maxOutputKb: String(options.maxOutputBytes / 1024),
    maxTimeoutSeconds: String(options.maxTimeoutSeconds),
    tmuxToolName: options.tmuxToolName,
  };
  return Object.entries(values).reduce(
    (text, [variable, value]) => fillVariable(text, variable, value),
    template,
  );
};

/** Render the configured tool snippet, unless disabled globally or per call. */
export const resolveSystemPromptToolSnippet = (
  snippet: string | false,
  options: ResolvedOptions,
): string | undefined => {
  if (!options.systemPrompt || snippet === false) return undefined;
  return renderPromptTemplate(snippet, options);
};

/** Render every configured prompt guideline (empty when prompts are off). */
export const systemPromptGuidelines = (options: ResolvedOptions): string[] => {
  if (!options.systemPrompt) return [];
  // Interim check-ins arrive automatically from the reconciler tick;
  // standalone pollers are retired, so nothing is advertised here.
  return options.systemPromptGuidelines.map((guideline) => renderPromptTemplate(guideline, options));
};
