import type { JsonSchema } from "../types";
import { appendHints } from "./schema-hints";

const SUPPORTED_STRING_FORMATS = new Set(["date-time", "time", "date", "duration", "email", "hostname", "uri", "ipv4", "ipv6", "uuid"]);
/** Keywords Anthropic structured outputs accept as-is (besides the structural ones handled below). */
const PASSTHROUGH = ["type", "enum", "const", "description", "title", "required"] as const;

/**
 * Rewrite a JSON Schema into the subset Anthropic structured outputs accept: every object closed
 * (`additionalProperties: false`), `oneOf` → `anyOf`, and unsupported constraints (lengths, patterns,
 * numeric bounds, defaults, minItems > 1, …) moved into the description as hints. The caller still
 * validates the full schema client-side. Unlike the SDK's transform, `enum` and `const` are kept.
 */
export function toStrictJsonSchema(schema: JsonSchema): JsonSchema {
  return strict(structuredClone(schema));
}

function strict(node: JsonSchema): JsonSchema {
  const rest: JsonSchema = { ...node };
  const out: JsonSchema = {};
  const take = (key: string) => {
    const v = rest[key];
    delete rest[key];
    return v;
  };

  const defs = take("$defs") as Record<string, JsonSchema> | undefined;
  if (defs) out.$defs = Object.fromEntries(Object.entries(defs).map(([k, v]) => [k, strict(v)]));
  const ref = take("$ref");
  if (ref !== undefined) {
    out.$ref = ref;
    return out;
  }

  for (const key of PASSTHROUGH) {
    const v = take(key);
    if (v !== undefined) out[key] = v;
  }
  const anyOf = (take("anyOf") ?? take("oneOf")) as JsonSchema[] | undefined;
  if (anyOf) out.anyOf = anyOf.map(strict);
  const allOf = take("allOf") as JsonSchema[] | undefined;
  if (allOf) out.allOf = allOf.map(strict);

  if (out.type === "object") {
    const props = (take("properties") ?? {}) as Record<string, JsonSchema>;
    out.properties = Object.fromEntries(Object.entries(props).map(([k, v]) => [k, strict(v)]));
    take("additionalProperties");
    out.additionalProperties = false;
  }
  if (out.type === "array") {
    const items = take("items") as JsonSchema | undefined;
    if (items) out.items = strict(items);
    const minItems = rest.minItems;
    if (minItems === 0 || minItems === 1) out.minItems = take("minItems");
  }
  if (out.type === "string" && typeof rest.format === "string" && SUPPORTED_STRING_FORMATS.has(rest.format)) {
    out.format = take("format");
  }
  return appendHints(out, rest);
}
