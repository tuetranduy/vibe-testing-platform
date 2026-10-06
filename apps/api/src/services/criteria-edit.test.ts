import { describeExpectedOutcome, type AcceptanceCriterion, type NormalizedRequirement } from "@platform/contracts";
import { describe, expect, it } from "vitest";
import { applyCriteriaEdit } from "./criteria-edit";

const facts: NormalizedRequirement["facts"] = [
  { key: "cartCount", checkpoint: "before_add", description: "Cart badge count", valueType: "number" },
  { key: "cartCount", checkpoint: "after_add", description: "Cart badge count", valueType: "number" },
  { key: "message", checkpoint: "after_add", description: "Confirmation text", valueType: "string" },
  { key: "items", checkpoint: "cart_page", description: "Items in the cart", valueType: "string_list" },
  { key: "banner", checkpoint: "home", description: "Cookie banner", valueType: "boolean" },
];
const ref = (key: string, checkpoint: string) => ({ key, checkpoint });

function criterion(id: string, expectedOutcome: AcceptanceCriterion["expectedOutcome"], patch: Partial<AcceptanceCriterion> = {}): AcceptanceCriterion {
  return { id, sourceText: "The cart holds 1 item.", statement: `${id} as the model wrote it`, expectedOutcome, preconditions: [], critical: true, ambiguity: null, ...patch };
}

function latest(): NormalizedRequirement {
  return {
    runId: "run_1",
    revision: 1,
    originalText: "The cart holds 1 item. A message appears. The cart lists the product. No banner.",
    confirmedAt: null,
    facts,
    criteria: [
      criterion("AC-1", { kind: "numeric_compare", left: ref("cartCount", "after_add"), operator: "eq", right: 1 }, {
        statement: "The cart holds 1 item",
        ambiguity: { reason: "Which count?", suggestions: [] },
      }),
      criterion("AC-2", { kind: "text_matches", fact: ref("message", "after_add"), match: { mode: "contains", value: "added", caseSensitive: false } }),
      criterion("AC-3", { kind: "numeric_delta", before: ref("cartCount", "before_add"), after: ref("cartCount", "after_add"), delta: 1 }),
      criterion("AC-4", { kind: "collection_contains", collection: ref("items", "cart_page"), item: "iPhone", match: "contains" }),
      criterion("AC-5", { kind: "visible", fact: ref("banner", "home"), expected: false }),
      criterion("AC-6", { kind: "semantic", description: "Looks right" }),
    ],
  };
}

/** The body a client sends: the latest revision with `edit` applied to one criterion. */
function bodyWith(id: string, edit: (c: AcceptanceCriterion) => AcceptanceCriterion) {
  const l = latest();
  return { criteria: l.criteria.map((c) => (c.id === id ? edit(c) : c)), facts: l.facts };
}
const outcomeOf = <K extends AcceptanceCriterion["expectedOutcome"]["kind"]>(c: AcceptanceCriterion, _kind: K) =>
  c.expectedOutcome as Extract<AcceptanceCriterion["expectedOutcome"], { kind: K }>;

describe("applyCriteriaEdit", () => {
  it("accepts an unchanged body and returns the latest criteria as they are", () => {
    const l = latest();
    const r = applyCriteriaEdit(l, { criteria: l.criteria, facts: l.facts });
    expect(r).toEqual({ ok: true, criteria: l.criteria, facts: l.facts });
  });

  it("regression: '1 item' → '2 items' changes the check, and the server writes the wording from it", () => {
    const r = applyCriteriaEdit(latest(), bodyWith("AC-1", (c) => ({ ...c, expectedOutcome: { ...outcomeOf(c, "numeric_compare"), right: 2 } })));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ac1 = r.criteria[0]!;
    expect(ac1.expectedOutcome).toEqual({ kind: "numeric_compare", left: ref("cartCount", "after_add"), operator: "eq", right: 2 });
    expect(ac1.statement).toBe("Cart badge count (at “after add”) equals 2.");
    expect(ac1.ambiguity).toBeNull();
  });

  it("ignores the statement a client sends with an edited check", () => {
    const r = applyCriteriaEdit(latest(), bodyWith("AC-3", (c) => ({ ...c, statement: "anything", expectedOutcome: { ...outcomeOf(c, "numeric_delta"), delta: 2 } })));
    expect(r.ok && r.criteria[2]!.statement).toBe(describeExpectedOutcome({ ...outcomeOf(latest().criteria[2]!, "numeric_delta"), delta: 2 }, facts));
  });

  it.each([
    ["visible expected", "AC-5", (c: AcceptanceCriterion) => ({ ...c, expectedOutcome: { ...outcomeOf(c, "visible"), expected: true } })],
    [
      "text mode/value/case",
      "AC-2",
      (c: AcceptanceCriterion) => ({ ...c, expectedOutcome: { ...outcomeOf(c, "text_matches"), match: { mode: "equals" as const, value: "Added!", caseSensitive: true } } }),
    ],
    ["compare operator", "AC-1", (c: AcceptanceCriterion) => ({ ...c, expectedOutcome: { ...outcomeOf(c, "numeric_compare"), operator: "gte" as const } })],
    ["delta", "AC-3", (c: AcceptanceCriterion) => ({ ...c, expectedOutcome: { ...outcomeOf(c, "numeric_delta"), delta: -1 } })],
    [
      "collection item and match",
      "AC-4",
      (c: AcceptanceCriterion) => ({ ...c, expectedOutcome: { ...outcomeOf(c, "collection_contains"), item: "iPhone 17 Pro", match: "equals" as const } }),
    ],
  ])("accepts an edit of %s", (_name, id, edit) => {
    const r = applyCriteriaEdit(latest(), bodyWith(id, edit));
    expect(r.ok).toBe(true);
    const saved = r.ok ? r.criteria.find((c) => c.id === id)! : null;
    expect(saved!.statement).toBe(describeExpectedOutcome(saved!.expectedOutcome, facts));
  });

  it("accepts removing a criterion, and drops facts no remaining criterion reads", () => {
    const l = latest();
    const r = applyCriteriaEdit(l, { criteria: l.criteria.filter((c) => c.id !== "AC-5"), facts: l.facts.filter((f) => f.key !== "banner") });
    expect(r.ok).toBe(true);
    expect(r.ok && r.criteria.map((c) => c.id)).toEqual(["AC-1", "AC-2", "AC-3", "AC-4", "AC-6"]);
    expect(r.ok && r.facts.some((f) => f.key === "banner")).toBe(false);
  });

  it("accepts editing an already-edited criterion again", () => {
    const first = applyCriteriaEdit(latest(), bodyWith("AC-1", (c) => ({ ...c, expectedOutcome: { ...outcomeOf(c, "numeric_compare"), right: 2 } })));
    if (!first.ok) throw new Error("first edit failed");
    const revision2: NormalizedRequirement = { ...latest(), revision: 2, criteria: first.criteria };
    const r = applyCriteriaEdit(revision2, {
      criteria: first.criteria.map((c) => (c.id === "AC-1" ? { ...c, expectedOutcome: { ...outcomeOf(c, "numeric_compare"), right: 3 } } : c)),
      facts,
    });
    expect(r.ok && r.criteria[0]!.statement).toBe("Cart badge count (at “after add”) equals 3.");
  });

  it("accepts marking a criterion non-critical without touching its wording or check (V1.1)", () => {
    const l = latest();
    const r = applyCriteriaEdit(l, bodyWith("AC-2", (c) => ({ ...c, critical: false })));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ac2 = r.criteria.find((c) => c.id === "AC-2")!;
    const before = l.criteria.find((c) => c.id === "AC-2")!;
    expect(ac2).toEqual({ ...before, critical: false });
    expect(r.criteria.filter((c) => c.id !== "AC-2")).toEqual(l.criteria.filter((c) => c.id !== "AC-2"));
  });

  it("keeps the weight sent with an edited check (V1.1)", () => {
    const r = applyCriteriaEdit(latest(), bodyWith("AC-1", (c) => ({ ...c, critical: false, expectedOutcome: { ...outcomeOf(c, "numeric_compare"), right: 2 } })));
    expect(r.ok && r.criteria.find((c) => c.id === "AC-1")).toMatchObject({ critical: false, statement: expect.stringContaining("2") });
  });

  it("rejects a wording-only change with STATEMENT_ONLY_EDIT", () => {
    const r = applyCriteriaEdit(latest(), bodyWith("AC-1", (c) => ({ ...c, statement: "The cart holds 2 items" })));
    expect(r).toEqual({ ok: false, code: "STATEMENT_ONLY_EDIT", issues: [{ path: ["criteria", 0, "statement"], message: expect.any(String) }] });
  });

  it.each([
    ["an added criterion", (l: NormalizedRequirement) => ({ criteria: [...l.criteria, { ...l.criteria[1]!, id: "AC-9" }], facts: l.facts }), ["criteria", 6, "id"]],
    ["a changed sourceText", () => bodyWith("AC-2", (c) => ({ ...c, sourceText: "A message appears." })), ["criteria", 1, "sourceText"]],
    [
      "changed preconditions",
      () => bodyWith("AC-2", (c) => ({ ...c, preconditions: [{ kind: "authenticated" as const, description: "x" }] })),
      ["criteria", 1, "preconditions"],
    ],
    [
      "a changed kind",
      () => bodyWith("AC-5", (c) => ({ ...c, expectedOutcome: { kind: "semantic" as const, description: "banner hidden" } })),
      ["criteria", 4, "expectedOutcome"],
    ],
    [
      "a changed fact reference",
      () => bodyWith("AC-1", (c) => ({ ...c, expectedOutcome: { ...outcomeOf(c, "numeric_compare"), left: ref("cartCount", "before_add") } })),
      ["criteria", 0, "expectedOutcome"],
    ],
    [
      "a literal replaced by a fact",
      () => bodyWith("AC-1", (c) => ({ ...c, expectedOutcome: { ...outcomeOf(c, "numeric_compare"), right: ref("cartCount", "before_add") } })),
      ["criteria", 0, "expectedOutcome"],
    ],
    [
      "an edited semantic description",
      () => bodyWith("AC-6", (c) => ({ ...c, expectedOutcome: { kind: "semantic" as const, description: "Looks great" } })),
      ["criteria", 5, "expectedOutcome"],
    ],
    ["a changed ambiguity on an unedited criterion", () => bodyWith("AC-1", (c) => ({ ...c, ambiguity: null })), ["criteria", 0, "ambiguity"]],
    [
      "an added fact",
      (l: NormalizedRequirement) => ({ criteria: l.criteria, facts: [...l.facts, { key: "extra", checkpoint: "home", description: "Extra", valueType: "string" as const }] }),
      ["facts", 5],
    ],
    [
      "a changed fact description",
      (l: NormalizedRequirement) => ({ criteria: l.criteria, facts: l.facts.map((f, i) => (i === 0 ? { ...f, description: "Badge" } : f)) }),
      ["facts", 0],
    ],
    [
      "a literal replaced by a test data key (KI-001)",
      () =>
        bodyWith("AC-2", (c) => ({ ...c, expectedOutcome: { ...outcomeOf(c, "text_matches"), match: { mode: "contains" as const, testDataKey: "email", caseSensitive: false } } })),
      ["criteria", 1, "expectedOutcome"],
    ],
    [
      "an edited regex that does not compile",
      () =>
        bodyWith("AC-2", (c) => ({ ...c, expectedOutcome: { ...outcomeOf(c, "text_matches"), match: { mode: "regex" as const, value: "(", caseSensitive: false } } })),
      ["criteria", 1, "expectedOutcome", "match", "value"],
    ],
  ])("rejects %s with VALIDATION_FAILED", (_name, make, path) => {
    const r = applyCriteriaEdit(latest(), make(latest()));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("VALIDATION_FAILED");
    expect(r.issues.map((i) => i.path)).toContainEqual(path);
  });

  it("a check against a test data value keeps its key; its mode and case can change (KI-001)", () => {
    const keyed = criterion("AC-2", { kind: "text_matches", fact: ref("message", "after_add"), match: { mode: "contains", testDataKey: "greeting", caseSensitive: false } });
    const l = { ...latest(), criteria: latest().criteria.map((c) => (c.id === "AC-2" ? keyed : c)) };
    const withMatch = (match: Record<string, unknown>) => ({ criteria: l.criteria.map((c) => (c.id === "AC-2" ? { ...c, expectedOutcome: { ...c.expectedOutcome, match } } : c)), facts: l.facts }) as never;

    const exact = applyCriteriaEdit(l, withMatch({ mode: "equals", testDataKey: "greeting", caseSensitive: true }));
    expect(exact.ok).toBe(true);
    if (exact.ok) expect(exact.criteria[1]!.statement).toBe("Confirmation text (at “after add”) is exactly the test data value “greeting” (case-sensitive).");

    for (const match of [{ mode: "contains", value: "added", caseSensitive: false }, { mode: "contains", testDataKey: "nickname", caseSensitive: false }]) {
      const r = applyCriteriaEdit(l, withMatch(match));
      expect(r.ok, JSON.stringify(match)).toBe(false);
    }
  });

  it("reports rule violations before a wording-only change", () => {
    const body = bodyWith("AC-1", (c) => ({ ...c, statement: "reworded" }));
    body.criteria[1] = { ...body.criteria[1]!, sourceText: "changed" };
    const r = applyCriteriaEdit(latest(), body);
    expect(!r.ok && r.code).toBe("VALIDATION_FAILED");
  });
});
