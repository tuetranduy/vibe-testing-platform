import { describe, expect, it } from "vitest";
import type { CompilerOutput as FullCompilerOutput } from "./model-output";

/** The criteria and facts: all postValidate reads (the advisory fields are validated apart, V1.3). */
type CompilerOutput = Pick<FullCompilerOutput, "criteria" | "facts">;
import { TEXT_NOT_STATED, THRESHOLD_NOT_STATED, normalizeText, numbersInText, postValidate, statedNumbers } from "./post-validate";

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

describe("postValidate: text checks against a test data value (KI-001)", () => {
  const text = "Log in and verify the account page shows the user's email";
  const keyed = (testDataKey: string, preconditions: CompilerOutput["criteria"][number]["preconditions"] = []): CompilerOutput => ({
    criteria: [
      {
        sourceText: "verify the account page shows the user's email",
        statement: "The account page shows the user's email",
        expectedOutcome: { kind: "text_matches", fact: { key: "accountEmail", checkpoint: "account_page" }, match: { mode: "contains", testDataKey, caseSensitive: false } },
        preconditions,
        ambiguity: null,
      },
    ],
    facts: [{ key: "accountEmail", checkpoint: "account_page", description: "Signed-in email", valueType: "string" }],
  });

  it("adds the key's test_data precondition when the model left it out, so a run without the value is BLOCKED", () => {
    const r = postValidate(keyed("email"), { originalText: text, testData: { email: "qa@demo.test" }, secretNames: ["password"] });
    if (!r.ok) throw new Error(r.issues.join());
    expect(r.draft.criteria[0]!.preconditions).toEqual([{ kind: "test_data", ref: "email", description: "The test data value “email”" }]);

    const stated = [{ kind: "test_data" as const, ref: "email", description: "The account email" }];
    const again = postValidate(keyed("email", stated), { originalText: text, testData: {}, secretNames: [] });
    if (!again.ok) throw new Error(again.issues.join());
    expect(again.draft.criteria[0]!.preconditions).toEqual(stated);
  });

  it("refuses a secret's name: a secret is never compared or shown (a correction round)", () => {
    const r = postValidate(keyed("password"), { originalText: text, testData: {}, secretNames: ["password"] });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.issues.join()).toMatch(/criteria\.0\.expectedOutcome\.match\.testDataKey: .*secret/);
  });
});

describe("postValidate: wording the requirement never wrote (KI-070)", () => {
  const textCheck = (text: string, value: string, o: { key?: string; mode?: "equals" | "contains" | "regex"; testData?: Record<string, string> } = {}) => {
    const key = o.key ?? "emptyMessage";
    const out: CompilerOutput = {
      criteria: [
        {
          sourceText: text,
          statement: "When no products have been added, the wishlist page shows its empty-state message.",
          expectedOutcome: { kind: "text_matches", fact: { key, checkpoint: "wishlist_page" }, match: { mode: o.mode ?? "contains", value, caseSensitive: false } },
          preconditions: [],
          ambiguity: null,
        },
      ],
      facts: [{ key, checkpoint: "wishlist_page", description: "The wishlist's empty-state message", valueType: "string" }],
    };
    return postValidate(out, { originalText: text, testData: o.testData ?? {} });
  };

  it("an exact text the model made up becomes a visible check on a boolean fact at the same checkpoint (the FD-05 run)", () => {
    const r = textCheck("Make sure the wishlist works", "Wishlist is empty");
    if (!r.ok) throw new Error(r.issues.join());
    const c = r.draft.criteria[0]!;
    expect(c.expectedOutcome).toEqual({ kind: "visible", fact: { key: "emptyMessageShown", checkpoint: "wishlist_page" }, expected: true });
    expect(c.ambiguity?.reason).toBe(`${TEXT_NOT_STATED} (the model expected "Wishlist is empty")`);
    expect(r.draft.facts).toEqual([
      { key: "emptyMessageShown", checkpoint: "wishlist_page", description: "Whether this is shown: The wishlist's empty-state message", valueType: "boolean" },
    ]);
  });

  it("text the requirement writes is kept, whatever its case, quotes and punctuation", () => {
    const r = textCheck('When nothing matches, the page says "No results found".', "no results found.");
    expect(r.ok && r.draft.criteria[0]!.expectedOutcome.kind).toBe("text_matches");
    const shoe = textCheck("Every result title contains the word shoes", "shoe");
    expect(shoe.ok && shoe.draft.criteria[0]!.expectedOutcome.kind).toBe("text_matches");
  });

  it("a test data value's text, a regex and the url fact are left alone", () => {
    const data = textCheck("The greeting uses the customer's first name", "Ada", { testData: { firstName: "Ada" } });
    expect(data.ok && data.draft.criteria[0]!.expectedOutcome.kind).toBe("text_matches");
    const regex = textCheck("The order number is shown", "^SW\\d+$", { mode: "regex" });
    expect(regex.ok && regex.draft.criteria[0]!.expectedOutcome.kind).toBe("text_matches");
  });

  it("the new key never collides with a fact the model declared", () => {
    const text = "Make sure the wishlist works";
    const r = postValidate(
      {
        criteria: [
          {
            sourceText: text,
            statement: "The empty wishlist says so",
            expectedOutcome: { kind: "text_matches", fact: { key: "msg", checkpoint: "wishlist_page" }, match: { mode: "contains", value: "Your wishlist is empty", caseSensitive: false } },
            preconditions: [],
            ambiguity: null,
          },
          {
            sourceText: text,
            statement: "A message is shown",
            expectedOutcome: { kind: "visible", fact: { key: "msgShown", checkpoint: "wishlist_page" }, expected: true },
            preconditions: [],
            ambiguity: null,
          },
        ],
        facts: [
          { key: "msg", checkpoint: "wishlist_page", description: "The message", valueType: "string" },
          { key: "msgShown", checkpoint: "wishlist_page", description: "Whether a message is shown", valueType: "boolean" },
        ],
      },
      { originalText: text, testData: {} },
    );
    if (!r.ok) throw new Error(r.issues.join());
    expect(r.draft.criteria[0]!.expectedOutcome).toMatchObject({ kind: "visible", fact: { key: "msgShown2" } });
    expect(r.draft.facts.map((f) => f.key)).toEqual(["msgShown", "msgShown2"]);
  });

  it("normalizeText", () => {
    expect(normalizeText("  “Wishlist   is EMPTY.” ")).toBe("wishlist is empty");
  });
});
