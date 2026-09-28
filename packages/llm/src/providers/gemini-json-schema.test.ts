import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { JsonSchema } from "../types";
import { toGeminiJsonSchema } from "./gemini-json-schema";

/**
 * The keywords the rewrite may send: those `responseJsonSchema` supports (@google/genai GenerateContentConfig
 * docs), less `oneOf` (rewritten) and array bounds, which the live API rejects on arrays of objects
 * (400 INVALID_ARGUMENT for the planner's 1–50 steps, 2026-09-27).
 */
const SUPPORTED = new Set([
  "$id", "$defs", "$ref", "$anchor", "type", "format", "title", "description", "enum", "items", "prefixItems",
  "minimum", "maximum", "anyOf", "properties", "additionalProperties", "required", "propertyOrdering",
]);

/** Every keyword in the schema that Gemini does not support, with its path. */
function unsupportedKeywords(node: unknown, path = "#"): string[] {
  if (typeof node !== "object" || node === null) return [];
  const found: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (!SUPPORTED.has(key)) found.push(`${path}/${key}`);
    if (key === "properties" || key === "$defs") {
      for (const [name, sub] of Object.entries(value as Record<string, unknown>)) found.push(...unsupportedKeywords(sub, `${path}/${key}/${name}`));
    } else if (key === "anyOf" || key === "prefixItems") {
      (value as unknown[]).forEach((sub, i) => found.push(...unsupportedKeywords(sub, `${path}/${key}/${i}`)));
    } else if (key === "items" || key === "additionalProperties") {
      found.push(...unsupportedKeywords(value, `${path}/${key}`));
    }
  }
  return found;
}

describe("toGeminiJsonSchema", () => {
  it("turns oneOf into anyOf and a string or number const into a one-value enum, so union tags stay enforced", () => {
    const out = toGeminiJsonSchema({
      type: "object",
      properties: {
        outcome: {
          oneOf: [
            {
              type: "object",
              properties: { kind: { type: "string", const: "visible" }, expected: { type: "boolean" } },
              required: ["kind", "expected"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: { kind: { type: "string", const: "semantic" }, weight: { type: "number", const: 2 } },
              required: ["kind", "weight"],
              additionalProperties: false,
            },
          ],
        },
        mode: { type: "string", enum: ["equals", "contains"] },
        ambiguity: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
      required: ["outcome", "mode", "ambiguity"],
      additionalProperties: false,
    });
    expect(out).toEqual({
      type: "object",
      properties: {
        outcome: {
          anyOf: [
            {
              type: "object",
              properties: { kind: { type: "string", enum: ["visible"] }, expected: { type: "boolean" } },
              required: ["kind", "expected"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: { kind: { type: "string", enum: ["semantic"] }, weight: { type: "number", enum: [2] } },
              required: ["kind", "weight"],
              additionalProperties: false,
            },
          ],
        },
        mode: { type: "string", enum: ["equals", "contains"] },
        ambiguity: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
      required: ["outcome", "mode", "ambiguity"],
      additionalProperties: false,
    });
  });

  it("moves constraints Gemini does not enforce (patterns, lengths, array bounds, defaults, …) into the description (validated client-side instead)", () => {
    const out = toGeminiJsonSchema({
      type: "object",
      properties: {
        key: { type: "string", pattern: "^[a-z]+$", minLength: 1, maxLength: 64, description: "Fact key" },
        caseSensitive: { type: "boolean", default: false },
        flag: { type: "boolean", const: true },
        email: { type: "string", format: "email" },
        at: { type: "string", format: "date-time" },
        count: { type: "integer", minimum: 0, maximum: 10, exclusiveMinimum: 0 },
        tags: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3, uniqueItems: true },
      },
      required: ["key"],
      additionalProperties: false,
    });
    expect(out).toEqual({
      type: "object",
      properties: {
        key: { type: "string", description: 'Fact key\n\n{pattern: "^[a-z]+$", minLength: 1, maxLength: 64}' },
        caseSensitive: { type: "boolean", description: "{default: false}" },
        flag: { type: "boolean", description: "{const: true}" },
        email: { type: "string", description: '{format: "email"}' },
        at: { type: "string", format: "date-time" },
        count: { type: "integer", minimum: 0, maximum: 10, description: "{exclusiveMinimum: 0}" },
        tags: { type: "array", items: { type: "string" }, description: "{minItems: 1, maxItems: 3, uniqueItems: true}" },
      },
      required: ["key"],
      additionalProperties: false,
    });
  });

  it("rewrites every nested schema: items, prefixItems and a schema-valued additionalProperties", () => {
    const out = toGeminiJsonSchema({
      type: "object",
      properties: {
        list: { type: "array", items: { type: "string", const: "y" } },
        pair: { type: "array", prefixItems: [{ type: "string", const: "x" }, { oneOf: [{ type: "number" }, { type: "null" }] }] },
        byName: { type: "object", additionalProperties: { type: "string", maxLength: 5 } },
      },
    });
    expect(out).toEqual({
      type: "object",
      properties: {
        list: { type: "array", items: { type: "string", enum: ["y"] } },
        pair: { type: "array", prefixItems: [{ type: "string", enum: ["x"] }, { anyOf: [{ type: "number" }, { type: "null" }] }] },
        byName: { type: "object", additionalProperties: { type: "string", description: "{maxLength: 5}" } },
      },
    });
  });

  it("drops the root $schema, keeps $defs and a bare $ref (Gemini allows no siblings next to $ref), and does not mutate the input", () => {
    const input: JsonSchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $defs: { Node: { type: "object", properties: { name: { type: "string", minLength: 1 } }, required: ["name"] } },
      type: "object",
      properties: { root: { $ref: "#/$defs/Node", description: "The root node" } },
      required: ["root"],
    };
    const snapshot = JSON.stringify(input);
    expect(toGeminiJsonSchema(input)).toEqual({
      $defs: { Node: { type: "object", properties: { name: { type: "string", description: "{minLength: 1}" } }, required: ["name"] } },
      type: "object",
      properties: { root: { $ref: "#/$defs/Node" } },
      required: ["root"],
    });
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("leaves only supported keywords in Zod-generated schemas like the compiler's, the planner's and Stagehand's", () => {
    const Fact = z.object({ key: z.string().regex(/^[a-z]+$/), checkpoint: z.string().min(1).max(64) });
    const schema = z.object({
      outcome: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("visible"), fact: Fact, expected: z.boolean().default(true) }),
        z.object({ kind: z.literal("semantic"), description: z.string().min(3).max(1000) }),
      ]),
      right: z.union([Fact, z.number()]),
      ambiguity: z.object({ reason: z.string().max(500), suggestions: z.array(z.string()).max(3) }).nullable(),
      steps: z.array(z.object({ kind: z.enum(["click", "fill"]), count: z.number().int().positive() })).min(1).max(50),
      action: z
        .object({ elementId: z.string().regex(/^\d+-\d+$/).describe("frame and node id") })
        .strict()
        .nullable()
        .describe("null when nothing matches"),
      pair: z.tuple([z.literal("x"), z.number()]),
      flag: z.literal(true),
      labels: z.record(z.string(), z.string().max(5)),
    });
    // As LlmClient (unrepresentable: "any") and Stagehand (defaults, with $schema) serialize schemas.
    for (const json of [z.toJSONSchema(schema, { unrepresentable: "any" }), z.toJSONSchema(schema)]) {
      expect(unsupportedKeywords(toGeminiJsonSchema(json as JsonSchema))).toEqual([]);
    }
  });
});
