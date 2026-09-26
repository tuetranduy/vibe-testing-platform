import { describe, expect, it } from "vitest";
import type { CompilerOutput } from "./model-output";
import { THRESHOLD_NOT_STATED, numbersInText, postValidate, statedNumbers } from "./post-validate";

describe("statedNumbers / numbersInText", () => {
  it("reads grouped digits both as thousands and as decimals", () => {
    expect(numbersInText("Costs CHF 1'299 or 1,5 kg, 2.000 items")).toEqual(expect.arrayContaining([1299, 1.299, 15, 1.5, 2000, 2]));
  });
  it("includes English number words and testData values (numbers and numeric strings)", () => {
    const s = statedNumbers("The count should increase by one.", { qty: 3, code: "SKU-42", flag: true, none: null });
    expect([...s].sort((a, b) => a - b)).toEqual([1, 3, 42]);
  });
});

const delta = (text: string, value: number): CompilerOutput => ({
  criteria: [
    {
      sourceText: text,
      statement: "Cart count changes",
      expectedOutcome: {
        kind: "numeric_delta",
        before: { key: "cartCount", checkpoint: "before" },
        after: { key: "cartCount", checkpoint: "after" },
        delta: value,
      },
      preconditions: [],
      ambiguity: null,
    },
  ],
  facts: [
    { key: "cartCount", checkpoint: "before", description: "Cart count", valueType: "number" },
    { key: "cartCount", checkpoint: "after", description: "Cart count", valueType: "number" },
  ],
});

describe("postValidate thresholds", () => {
  it("keeps a delta stated in words, compared by magnitude (decrease by one → -1)", () => {
    const text = "Removing an item should decrease the cart count by one.";
    const r = postValidate(delta(text, -1), { originalText: text, testData: {} });
    expect(r.ok && r.draft.criteria[0]!.expectedOutcome.kind).toBe("numeric_delta");
  });

  it("rewrites an invented delta and keeps the model's own suggestions after the original statement", () => {
    const text = "The cart count should increase.";
    const out = delta(text, 2);
    out.criteria[0]!.ambiguity = { reason: "unclear", suggestions: ["Increase by 1"] };
    const r = postValidate(out, { originalText: text, testData: {} });
    if (!r.ok) throw new Error(r.issues.join());
    expect(r.draft.criteria[0]!.ambiguity).toEqual({ reason: THRESHOLD_NOT_STATED, suggestions: ["Cart count changes", "Increase by 1"] });
    expect(r.draft.facts).toEqual([]);
  });

  it("flags digits invented inside expected text", () => {
    const text = "The search shows results for shoes.";
    const r = postValidate(
      {
        criteria: [
          {
            sourceText: text,
            statement: "Shows 10 results",
            expectedOutcome: { kind: "text_matches", fact: { key: "summary", checkpoint: "results" }, match: { mode: "contains", value: "10 results", caseSensitive: false } },
            preconditions: [],
            ambiguity: null,
          },
        ],
        facts: [{ key: "summary", checkpoint: "results", description: "Result summary", valueType: "string" }],
      },
      { originalText: text, testData: {} },
    );
    expect(r.ok && r.draft.criteria[0]!.expectedOutcome.kind).toBe("semantic");
  });

  const single = (text: string, expectedOutcome: CompilerOutput["criteria"][number]["expectedOutcome"], valueType: "number" | "string"): CompilerOutput => ({
    criteria: [{ sourceText: text, statement: "Check", expectedOutcome, preconditions: [], ambiguity: null }],
    facts: [{ key: "value", checkpoint: "page", description: "Value", valueType }],
  });

  it("treats 0 as always stated (\"not empty\" → gt 0)", () => {
    const text = "The cart is not empty after adding a product.";
    const r = postValidate(
      single(text, { kind: "numeric_compare", left: { key: "value", checkpoint: "page" }, operator: "gt", right: 0 }, "number"),
      { originalText: text, testData: {} },
    );
    if (!r.ok) throw new Error(r.issues.join());
    expect(r.draft.criteria[0]!.expectedOutcome.kind).toBe("numeric_compare");
    expect(r.draft.criteria[0]!.ambiguity).toBeNull();
  });

  it("does not scan regex text_matches patterns for digits", () => {
    const text = "The order confirmation shows an order number.";
    const r = postValidate(
      single(text, { kind: "text_matches", fact: { key: "value", checkpoint: "page" }, match: { mode: "regex", value: "Order #\\d{6,8}", caseSensitive: false } }, "string"),
      { originalText: text, testData: {} },
    );
    if (!r.ok) throw new Error(r.issues.join());
    expect(r.draft.criteria[0]!.expectedOutcome.kind).toBe("text_matches");
  });

  it("still flags a non-zero number invented in a numeric_compare", () => {
    const text = "The cart is not empty after adding a product.";
    const r = postValidate(
      single(text, { kind: "numeric_compare", left: { key: "value", checkpoint: "page" }, operator: "gte", right: 2 }, "number"),
      { originalText: text, testData: {} },
    );
    expect(r.ok && r.draft.criteria[0]!.expectedOutcome.kind).toBe("semantic");
  });
});
