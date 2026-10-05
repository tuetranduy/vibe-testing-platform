import type { AcceptanceCriterion, NormalizedRequirement } from "@platform/contracts";
import { describe, expect, it } from "vitest";
import { resolveTestDataValues } from "./test-data-values";

const criterion = (id: string, expectedOutcome: AcceptanceCriterion["expectedOutcome"]): AcceptanceCriterion => ({
  id,
  sourceText: "x",
  statement: `Statement of ${id}`,
  expectedOutcome,
  preconditions: [],
  critical: true,
  ambiguity: null,
});
const fact = { key: "accountEmail", checkpoint: "account_page" };
const requirement = (criteria: AcceptanceCriterion[]): Pick<NormalizedRequirement, "criteria"> => ({ criteria });

describe("resolveTestDataValues (KI-001)", () => {
  it("replaces a text check's test data key with the run's value, as text", () => {
    const req = requirement([
      criterion("AC-1", { kind: "text_matches", fact, match: { mode: "contains", testDataKey: "email", caseSensitive: false } }),
      criterion("AC-2", { kind: "text_matches", fact, match: { mode: "equals", testDataKey: "quantity", caseSensitive: true } }),
    ]);
    const out = resolveTestDataValues(req, { email: "qa@demo.test", quantity: 2 });
    expect(out.criteria.map((c) => c.expectedOutcome)).toEqual([
      { kind: "text_matches", fact, match: { mode: "contains", value: "qa@demo.test", caseSensitive: false } },
      { kind: "text_matches", fact, match: { mode: "equals", value: "2", caseSensitive: true } },
    ]);
    // The input is untouched (it is the stored requirement).
    expect(req.criteria[0]!.expectedOutcome).toMatchObject({ match: { testDataKey: "email" } });
  });

  it("leaves a key the run has no value for (missing, null or empty) unresolved, and every other check as it is", () => {
    const literal = criterion("AC-3", { kind: "text_matches", fact, match: { mode: "contains", value: "Welcome", caseSensitive: false } });
    const visible = criterion("AC-4", { kind: "visible", fact, expected: true });
    const keyed = (key: string) => criterion("AC-1", { kind: "text_matches", fact, match: { mode: "contains", testDataKey: key, caseSensitive: false } });
    const out = resolveTestDataValues(requirement([keyed("email"), keyed("nickname"), keyed("blank"), literal, visible]), { nickname: null, blank: "" });
    expect(out.criteria.slice(0, 3).map((c) => c.expectedOutcome)).toEqual([keyed("email"), keyed("nickname"), keyed("blank")].map((c) => c.expectedOutcome));
    expect(out.criteria[3]).toBe(literal);
    expect(out.criteria[4]).toBe(visible);
  });
});
