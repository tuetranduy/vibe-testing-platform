import { describe, expect, it } from "vitest";
import { describeExpectedOutcome, STATEMENT_MAX_LENGTH } from "./describe-outcome";
import type { ExpectedOutcome, FactRequest } from "./requirement";

const facts: FactRequest[] = [
  { key: "cartCount", checkpoint: "before_add", description: "Cart badge count", valueType: "number" },
  { key: "cartCount", checkpoint: "after_add", description: "Cart badge count", valueType: "number" },
  { key: "cartItems", checkpoint: "after_add", description: "Items in the cart", valueType: "string_list" },
  { key: "heading", checkpoint: "results", description: "Search results heading", valueType: "string" },
  { key: "banner", checkpoint: "home", description: "Cookie banner", valueType: "boolean" },
  { key: "chosenProduct", checkpoint: "results", description: "Name of the chosen product", valueType: "string" },
];
const at = (key: string, checkpoint: string) => ({ key, checkpoint });
const text = (o: ExpectedOutcome) => describeExpectedOutcome(o, facts);

describe("describeExpectedOutcome", () => {
  it("visible", () => {
    expect(text({ kind: "visible", fact: at("banner", "home"), expected: true })).toBe("Cookie banner (at “home”) is visible.");
    expect(text({ kind: "visible", fact: at("banner", "home"), expected: false })).toBe("Cookie banner (at “home”) is not visible.");
  });

  it("text_matches: equals / contains / regex, with case", () => {
    const fact = at("heading", "results");
    expect(text({ kind: "text_matches", fact, match: { mode: "equals", value: "Results", caseSensitive: false } })).toBe(
      "Search results heading (at “results”) is exactly “Results” (ignoring case).",
    );
    expect(text({ kind: "text_matches", fact, match: { mode: "contains", value: "iPhone", caseSensitive: true } })).toBe(
      "Search results heading (at “results”) contains “iPhone” (case-sensitive).",
    );
    expect(text({ kind: "text_matches", fact, match: { mode: "regex", value: "^\\d+ results$", caseSensitive: false } })).toBe(
      "Search results heading (at “results”) matches the pattern “^\\d+ results$” (ignoring case).",
    );
  });

  it("numeric_compare: every operator, against a fact or a number", () => {
    const left = at("cartCount", "after_add");
    const cases = [
      ["eq", "equals"],
      ["neq", "does not equal"],
      ["gt", "is greater than"],
      ["gte", "is at least"],
      ["lt", "is less than"],
      ["lte", "is at most"],
    ] as const;
    for (const [operator, words] of cases) {
      expect(text({ kind: "numeric_compare", left, operator, right: 3 })).toBe(`Cart badge count (at “after add”) ${words} 3.`);
    }
    expect(text({ kind: "numeric_compare", left, operator: "gt", right: at("cartCount", "before_add") })).toBe(
      "Cart badge count (at “after add”) is greater than Cart badge count (at “before add”).",
    );
  });

  it("numeric_delta: up, down and unchanged", () => {
    const before = at("cartCount", "before_add");
    const after = at("cartCount", "after_add");
    expect(text({ kind: "numeric_delta", before, after, delta: 1 })).toBe(
      "Cart badge count (at “after add”) is exactly 1 more than Cart badge count (at “before add”).",
    );
    expect(text({ kind: "numeric_delta", before, after, delta: -2.5 })).toBe(
      "Cart badge count (at “after add”) is exactly 2.5 less than Cart badge count (at “before add”).",
    );
    expect(text({ kind: "numeric_delta", before, after, delta: 0 })).toBe(
      "Cart badge count (at “after add”) is the same as Cart badge count (at “before add”).",
    );
  });

  it("collection_contains: a literal item or another fact, contains or equals", () => {
    const collection = at("cartItems", "after_add");
    expect(text({ kind: "collection_contains", collection, item: "iPhone", match: "contains" })).toBe(
      "Items in the cart (at “after add”) include an item containing “iPhone”.",
    );
    expect(text({ kind: "collection_contains", collection, item: "iPhone 15", match: "equals" })).toBe(
      "Items in the cart (at “after add”) include an item that is exactly “iPhone 15”.",
    );
    expect(text({ kind: "collection_contains", collection, item: at("chosenProduct", "results"), match: "equals" })).toBe(
      "Items in the cart (at “after add”) include an item that is exactly Name of the chosen product (at “results”).",
    );
  });

  it("semantic: judged by AI only, ends Inconclusive", () => {
    expect(text({ kind: "semantic", description: "The page responds quickly" })).toBe(
      "Judged by AI only, so it ends Inconclusive: “The page responds quickly”.",
    );
  });

  it("falls back to the fact's key, and names the automatic page URL", () => {
    expect(describeExpectedOutcome({ kind: "visible", fact: at("promoCode", "checkout"), expected: true }, [])).toBe(
      "promoCode (at “checkout”) is visible.",
    );
    expect(
      describeExpectedOutcome(
        { kind: "text_matches", fact: at("url", "after_login"), match: { mode: "contains", value: "/account", caseSensitive: false } },
        [],
      ),
    ).toBe("The page address (at “after login”) contains “/account” (ignoring case).");
  });

  it("clips a generated sentence to the statement limit", () => {
    const long = "x".repeat(500);
    const wide: FactRequest[] = [{ key: "heading", checkpoint: "results", description: "d".repeat(500), valueType: "string" }];
    const out = describeExpectedOutcome(
      { kind: "text_matches", fact: at("heading", "results"), match: { mode: "equals", value: long, caseSensitive: false } },
      wide,
    );
    expect(out).toHaveLength(STATEMENT_MAX_LENGTH);
    expect(out.endsWith("…")).toBe(true);
  });

  it("leaves a short sentence unclipped", () => {
    expect(text({ kind: "visible", fact: at("banner", "home"), expected: true }).endsWith("…")).toBe(false);
  });
});
