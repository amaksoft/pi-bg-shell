import { Type } from "@sinclair/typebox";
import { z } from "zod";

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const dropUndefined = (schema: JsonRecord): JsonRecord =>
  Object.fromEntries(Object.entries(schema).filter(([, value]) => value !== undefined));

/** Collect every object-shaped variant under oneOf/anyOf (recursive). */
const variantsOf = (schema: JsonRecord, out: JsonRecord[] = []): JsonRecord[] => {
  if (schema.type === "object") {
    out.push(schema);
    return out;
  }
  for (const key of ["oneOf", "anyOf"] as const) {
    const branch = schema[key];
    if (Array.isArray(branch)) for (const item of branch) if (isRecord(item)) variantsOf(item, out);
  }
  return out;
};

const stringsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const constAndEnumValues = (schema: JsonRecord): unknown[] => {
  if (schema.const !== undefined) return [schema.const];
  return Array.isArray(schema.enum) ? schema.enum : [];
};

const firstText = (schemas: JsonRecord[]): string | undefined => {
  for (const schema of schemas) {
    if (typeof schema.description === "string") return schema.description;
  }
  return undefined;
};

const firstDefault = (schemas: JsonRecord[]): unknown => {
  for (const schema of schemas) {
    if (schema.default !== undefined) return schema.default;
  }
  return undefined;
};

/**
 * Merge one property across union variants into a single provider-friendly
 * schema: identical variants pass through; discriminators loosen to their
 * shared primitive (literals become an enum, single booleans plain type).
 */
const mergeVariants = (schemas: JsonRecord[]): JsonRecord => {
  const [head, ...rest] = schemas;
  if (!head) return {};
  if (rest.every((schema) => JSON.stringify(schema) === JSON.stringify(head))) return head;
  const description = firstText(schemas);
  const defaultValue = firstDefault(schemas);
  const meta: JsonRecord = {
    ...(description ? { description } : {}),
    ...(defaultValue !== undefined ? { default: defaultValue } : {}),
  };
  const values = [...new Set(schemas.flatMap(constAndEnumValues).map((value) => JSON.stringify(value)))].map(
    (json) => JSON.parse(json) as unknown,
  );
  const types = [...new Set(schemas.map((schema) => schema.type).filter((type) => typeof type === "string"))];
  if (values.length > 0 && types.length <= 1) {
    return { ...meta, ...(types.length === 1 ? { type: types[0] } : {}), enum: values };
  }
  if (types.length === 1) return { ...meta, type: types[0] };
  return meta;
};

const providerObjectSchema = (root: JsonRecord): JsonRecord => {
  const variants = variantsOf(root);
  if (root.type === "object" && variants.length <= 1) return dropUndefined(root);
  const properties: JsonRecord = {};
  for (const variant of variants) {
    const props = variant.properties;
    if (!isRecord(props)) continue;
    for (const [key, prop] of Object.entries(props)) {
      if (!isRecord(prop)) continue;
      properties[key] = properties[key] && isRecord(properties[key])
        ? mergeVariants([properties[key] as JsonRecord, prop])
        : prop;
    }
  }
  const requiredLists = variants.map((variant) => stringsOf(variant.required));
  const [first, ...rest] = requiredLists;
  const required = (first ?? []).filter((key) => rest.every((keys) => keys.includes(key)));
  return dropUndefined({
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
  });
};

export const defineZodToolCall = <TZod extends z.ZodType, TInvalidResult>(input: {
  toolName: string;
  zodSchema: TZod;
  invalidInput: (message: string) => TInvalidResult;
}) => {
  const handleInput = async <TResult>(
    params: unknown,
    onValid: (data: z.infer<TZod>) => Promise<TResult> | TResult,
  ) => {
    const parsed = input.zodSchema.safeParse(params);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((issue) => issue.message).join("; ");
      return input.invalidInput(`Invalid ${input.toolName} input: ${detail}`);
    }
    return onValid(parsed.data);
  };

  return {
    toolName: input.toolName,
    zodSchema: input.zodSchema,
    typeBoxSchema: Type.Unsafe<z.input<TZod>>(
      providerObjectSchema(z.toJSONSchema(input.zodSchema, { io: "input" }) as JsonRecord),
    ),
    handleInput,
  };
};
