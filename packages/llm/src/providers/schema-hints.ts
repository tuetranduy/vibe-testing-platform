import type { JsonSchema } from "../types";

/**
 * Keep the keywords a provider cannot enforce visible to the model: they are appended to the node's
 * description as `{keyword: value, …}`. The client validates the full schema after the call.
 */
export function appendHints(out: JsonSchema, unsupported: JsonSchema): JsonSchema {
  const hints = Object.entries(unsupported);
  if (hints.length === 0) return out;
  const text = `{${hints.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ")}}`;
  out.description = typeof out.description === "string" ? `${out.description}\n\n${text}` : text;
  return out;
}
