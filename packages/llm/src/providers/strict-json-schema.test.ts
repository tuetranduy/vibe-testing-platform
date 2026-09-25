import { describe, expect, it } from "vitest";
import { toStrictJsonSchema } from "./strict-json-schema";

describe("toStrictJsonSchema", () => {
  it("closes objects, keeps enum/const/anyOf, turns oneOf into anyOf", () => {
    const out = toStrictJsonSchema({
      type: "object",
      properties: {
        kind: { type: "string", const: "visible" },
        mode: { type: "string", enum: ["a", "b"] },
        v: { oneOf: [{ type: "number" }, { type: "object", properties: { k: { type: "string" } }, required: ["k"] }] },
      },
      required: ["kind", "mode", "v"],
    });
    expect(out).toEqual({
      type: "object",
      properties: {
        kind: { type: "string", const: "visible" },
        mode: { type: "string", enum: ["a", "b"] },
        v: {
          anyOf: [
            { type: "number" },
            { type: "object", properties: { k: { type: "string" } }, required: ["k"], additionalProperties: false },
          ],
        },
      },
      required: ["kind", "mode", "v"],
      additionalProperties: false,
    });
  });

  it("moves unsupported constraints into the description (validated client-side instead)", () => {
    const out = toStrictJsonSchema({
      type: "array",
      minItems: 3,
      maxItems: 20,
      items: { type: "string", minLength: 1, maxLength: 5, pattern: "^[a-z]+$", description: "id", format: "email" },
    });
    expect(out).toEqual({
      type: "array",
      description: '{minItems: 3, maxItems: 20}',
      items: { type: "string", format: "email", description: 'id\n\n{minLength: 1, maxLength: 5, pattern: "^[a-z]+$"}' },
    });
  });

  it("keeps minItems 0/1, $defs and $ref, and does not mutate the input", () => {
    const input = {
      $defs: { Ref: { type: "object", properties: {} } },
      type: "object",
      properties: { list: { type: "array", minItems: 1, items: { $ref: "#/$defs/Ref" } } },
    };
    const snapshot = JSON.stringify(input);
    const out = toStrictJsonSchema(input);
    expect(out).toEqual({
      $defs: { Ref: { type: "object", properties: {}, additionalProperties: false } },
      type: "object",
      properties: { list: { type: "array", minItems: 1, items: { $ref: "#/$defs/Ref" } } },
      additionalProperties: false,
    });
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
