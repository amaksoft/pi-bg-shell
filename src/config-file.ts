import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { z } from "zod";

const TEMPLATE_META_KEY = "bgShellTemplate";

export type MissingTemplateBehavior = "keep" | "throw";

export type TemplateOptions = {
  variables: string[];
  missing?: MissingTemplateBehavior;
};

/** A string field that may reference `{{variables}}` from sibling config. */
export const templatedString = (options: TemplateOptions): z.ZodString =>
  z.string().meta({
    [TEMPLATE_META_KEY]: { variables: [...options.variables], missing: options.missing ?? "throw" },
  });

export const loadConfigOrDefault = <Schema extends z.ZodType>(input: {
  folder?: string;
  filename: string;
  schema: Schema;
}): z.infer<Schema> => {
  const folder = input.folder ?? process.env.PI_EXTENSION_CONFIG_DIR ?? getAgentDir();
  const filePath = resolve(folder, input.filename);
  const raw = existsSync(filePath) ? parseJsoncFile(filePath) : {};
  const rendered = renderTemplates(input.schema, raw, raw, "config");
  const parsed = input.schema.safeParse(rendered);
  if (!parsed.success) throw new Error(`Invalid config in ${filePath}:\n${parsed.error.message}`);
  return parsed.data;
};

const parseJsoncFile = (filePath: string): unknown => {
  const content = readFileSync(filePath, "utf8");
  const errors: ParseError[] = [];
  const value = parse(content, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    const [first] = errors;
    throw new Error(
      `Invalid JSONC in ${filePath}:${lineOf(content, first!.offset)}: ${printParseErrorCode(first!.error)}`,
    );
  }
  return value;
};

const lineOf = (content: string, offset: number): string => {
  const before = content.slice(0, offset).split("\n");
  return `${before.length}:${(before.at(-1)?.length ?? 0) + 1}`;
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  Object.prototype.toString.call(value) === "[object Object]";

const innerOf = (schema: z.ZodType): z.ZodType | undefined => {
  const def = schema.def as { innerType?: z.ZodType };
  return def.innerType;
};

const templateOf = (schema: z.ZodType): TemplateOptions | undefined => {
  const meta = schema.meta() as Record<string, TemplateOptions | undefined> | undefined;
  if (meta?.[TEMPLATE_META_KEY]) return meta[TEMPLATE_META_KEY];
  const inner = innerOf(schema);
  return inner ? templateOf(inner) : undefined;
};

const renderTemplates = (schema: z.ZodType, value: unknown, root: unknown, path: string): unknown => {
  const template = templateOf(schema);
  if (template) {
    if (typeof value !== "string") return value;
    return fillTemplate(value, isPlainRecord(root) ? root : {}, { ...template, fieldPath: path });
  }
  if (schema instanceof z.ZodObject && isPlainRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, fieldValue]) => {
        const fieldSchema = (schema.shape[key] as z.ZodType | undefined) ?? z.unknown();
        return [key, renderTemplates(fieldSchema, fieldValue, root, `${path}.${key}`)];
      }),
    );
  }
  if (schema instanceof z.ZodArray && Array.isArray(value)) {
    return value.map((item, index) =>
      renderTemplates(schema.element as z.ZodType, item, root, `${path}.${index}`),
    );
  }
  const def = schema.def as { options?: z.ZodType[] };
  if (Array.isArray(def.options)) {
    const match = def.options.find((option) => matchesRuntimeType(option, value));
    return match ? renderTemplates(match, value, root, path) : value;
  }
  return value;
};

const matchesRuntimeType = (schema: z.ZodType, value: unknown): boolean => {
  const inner = innerOf(schema);
  if (inner) return matchesRuntimeType(inner, value);
  if (schema instanceof z.ZodString) return typeof value === "string";
  if (schema instanceof z.ZodNumber) return typeof value === "number";
  if (schema instanceof z.ZodBoolean) return typeof value === "boolean";
  if (schema instanceof z.ZodArray) return Array.isArray(value);
  if (schema instanceof z.ZodObject) return isPlainRecord(value);
  return schema.safeParse(value).success;
};

const fillTemplate = (
  template: string,
  values: Record<string, unknown>,
  options: TemplateOptions & { fieldPath: string },
): string => {
  checkBraces(template, options.fieldPath);
  return template.replace(/{{\s*([^{}]*?)\s*}}/g, (match, body: string) => {
    const variable = body.trim();
    checkBody(variable, options.fieldPath);
    if (!options.variables.includes(variable)) {
      throw new Error(
        `${options.fieldPath} uses unknown template variable "${variable}". Allowed: ${options.variables.join(", ")}`,
      );
    }
    if (!Object.hasOwn(values, variable) || values[variable] === undefined) {
      if ((options.missing ?? "throw") === "keep") return match;
      throw new Error(`${options.fieldPath} uses missing template variable "${variable}"`);
    }
    const replacement = values[variable];
    if (typeof replacement === "string" || typeof replacement === "number" || typeof replacement === "boolean") {
      return String(replacement);
    }
    throw new Error(`${options.fieldPath} uses unsupported template value "${variable}"`);
  });
};

const checkBraces = (template: string, fieldPath: string): void => {
  let index = 0;
  for (;;) {
    const open = template.indexOf("{{", index);
    const close = template.indexOf("}}", index);
    if (close !== -1 && (open === -1 || close < open)) {
      throw new Error(`${fieldPath} has unopened template close "}}"`);
    }
    if (open === -1) return;
    const end = template.indexOf("}}", open + 2);
    if (end === -1) throw new Error(`${fieldPath} has unclosed template open "{{"`);
    checkBody(template.slice(open + 2, end), fieldPath);
    index = end + 2;
  }
};

const checkBody = (body: string, fieldPath: string): void => {
  if (!body.trim()) throw new Error(`${fieldPath} has an empty template variable`);
  if (/[{}]/.test(body)) throw new Error(`${fieldPath} has a malformed template variable`);
};
