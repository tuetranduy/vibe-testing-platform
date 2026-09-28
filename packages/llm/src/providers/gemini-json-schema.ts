import type { JsonSchema } from "../types";
import { appendHints } from "./schema-hints";

const SUPPORTED_STRING_FORMATS = new Set(["date-time", "date", "time"]);
/**
 * Keywords Gemini's `responseJsonSchema` accepts as-is (besides the structural ones handled below).
 * Not `minItems` / `maxItems`, though documented: the API rejects a schema whose bounded arrays hold
 * objects (400 INVALID_ARGUMENT for the planner's 1–50 steps, 2026-09-27).
 */
const PASSTHROUGH = ["$id", "$anchor", "type", "title", "description", "required", "minimum", "maximum", "propertyOrdering"] as const;

/**
 * Rewrite a JSON Schema into the subset Gemini's `responseJsonSchema` accepts: `oneOf` → `anyOf`, a
 * string or number `const` → a one-value `enum` (so discriminated unions keep their tag), no root
 * `$schema`, nothing beside a `$ref`, and every other keyword (patterns, lengths, array bounds,
 * defaults, exclusive bounds, …) moved into the description as a hint. The caller still validates
 * the full schema client-side.
 */
export function toGeminiJsonSchema(schema: JsonSchema): JsonSchema {
  const { $schema: _dialect, ...root } = schema;
  return rewrite(structuredClone(root));
}

function rewrite(node: JsonSchema): JsonSchema {
  const rest: JsonSchema = { ...node };
  const out: JsonSchema = {};
  const take = (key: string) => {
    const v = rest[key];
    delete rest[key];
    return v;
  };

  const defs = take("$defs") as Record<string, JsonSchema> | undefined;
  if (defs) out.$defs = mapSchemas(defs);
  const ref = take("$ref");
  if (ref !== undefined) {
    out.$ref = ref;
    return out;
  }

  for (const key of PASSTHROUGH) {
    const v = take(key);
    if (v !== undefined) out[key] = v;
  }
  if (Array.isArray(rest.enum) && rest.enum.every(isEnumValue)) out.enum = take("enum");
  else if (rest.enum === undefined && isEnumValue(rest.const)) out.enum = [take("const")];
  const anyOf = (take("anyOf") ?? take("oneOf")) as JsonSchema[] | undefined;
  if (anyOf) out.anyOf = anyOf.map(rewrite);
  const props = take("properties") as Record<string, JsonSchema> | undefined;
  if (props) out.properties = mapSchemas(props);
  const additional = take("additionalProperties");
  if (additional !== undefined) out.additionalProperties = isSchema(additional) ? rewrite(additional) : additional;
  const items = take("items");
  if (items !== undefined) out.items = isSchema(items) ? rewrite(items) : items;
  const prefixItems = take("prefixItems") as JsonSchema[] | undefined;
  if (prefixItems) out.prefixItems = prefixItems.map(rewrite);
  if (typeof rest.format === "string" && SUPPORTED_STRING_FORMATS.has(rest.format)) out.format = take("format");
  return appendHints(out, rest);
}

const isEnumValue = (v: unknown): boolean => typeof v === "string" || typeof v === "number";
const isSchema = (v: unknown): v is JsonSchema => typeof v === "object" && v !== null && !Array.isArray(v);
const mapSchemas = (schemas: Record<string, JsonSchema>) => Object.fromEntries(Object.entries(schemas).map(([k, v]) => [k, rewrite(v)]));
