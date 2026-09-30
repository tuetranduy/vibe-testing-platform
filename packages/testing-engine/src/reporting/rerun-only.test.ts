import { CriterionResultSchema, type GeneratedTest, type NormalizedRequirement, type RerunResult } from "@platform/contracts";
import { describe, expect, it } from "vitest";
import { aggregateVerdict } from "../verification/aggregate";
import { rerunOnlyResults } from "./rerun-only";

const count = { key: "cartCount", checkpoint: "after_add" };
const requirement: NormalizedRequirement = {
  runId: "run_2",
  revision: 1,
  originalText: "The cart count is 1. The page feels fast. The title is right.",
  criteria: [
    {
      id: "AC-1",
      sourceText: "The cart count is 1.",
      statement: "Cart count is 1",
      expectedOutcome: { kind: "numeric_compare", left: count, operator: "eq", right: 1 },
      preconditions: [],
      critical: true,
      ambiguity: null,
    },
    {
      id: "AC-2",
      sourceText: "The page feels fast.",
      statement: "Feels fast",
      expectedOutcome: { kind: "semantic", description: "The page feels fast" },
      preconditions: [],
      critical: true,
      ambiguity: null,
    },
    {
      id: "AC-3",
      sourceText: "The title is right.",
      statement: "Title",
      expectedOutcome: { kind: "visible", fact: count, expected: true },
      preconditions: [],
      critical: false,
      ambiguity: null,
    },
  ],
  facts: [{ key: "cartCount", checkpoint: "after_add", description: "Cart count", valueType: "number" }],
  confirmedAt: "2026-09-29T10:00:00.000Z",
};
const test: GeneratedTest = {
  id: "gt_1",
  source: "",
  helpersSource: "",
  dataJson: "{}",
  compiledCriteria: ["AC-1", "AC-3"],
  notCompiled: [{ criterionId: "AC-2", reason: "AI-judged" }],
  notes: [],
};
const rerun = (perCriterion: RerunResult["perCriterion"], patch: Partial<RerunResult> = {}): RerunResult => ({
  status: "PASSED",
  perCriterion,
  durationMs: 900,
  errorText: {},
  artifactIds: [],
  ...patch,
});

const rows = (r: ReturnType<typeof rerunOnlyResults>) => r.map((c) => [c.criterionId, c.status, c.reason, c.verdictSource, c.rerunOutcome]);

describe("rerunOnlyResults (V1.1 F5)", () => {
  it("PASSED → PASS and ASSERTION_FAILED → FAIL, both confirmed by the rerun; not compiled → NOT_IN_GENERATED_TEST", () => {
    const results = rerunOnlyResults(
      requirement,
      test,
      rerun(
        { "AC-1": "PASSED", "AC-3": "ASSERTION_FAILED" },
        { status: "FAILED", artifactIds: ["art_trace"], errorText: { "AC-3": "expected visible" } },
      ),
    );
    for (const r of results) expect(CriterionResultSchema.parse(r)).toEqual(r);
    expect(rows(results)).toEqual([
      ["AC-1", "PASS", null, "PLAYWRIGHT_RERUN", "PASSED"],
      ["AC-2", "INCONCLUSIVE", "NOT_IN_GENERATED_TEST", null, "UNAVAILABLE"],
      ["AC-3", "FAIL", null, "PLAYWRIGHT_RERUN", "ASSERTION_FAILED"],
    ]);
    expect(results[2]).toMatchObject({
      actual: "Rerun: expected visible",
      evidenceArtifactIds: ["art_trace"],
      critical: false,
      provisional: { status: "FAIL", reason: null },
    });
    expect(results[0]).toMatchObject({ expected: "Cart count (at “after add”) equals 1.", evidenceArtifactIds: [], factRefs: [count] });
  });

  it("never a PASS the rerun did not assert: NOT_REACHED, a missing outcome and an ERRORED rerun are INCONCLUSIVE", () => {
    expect(rows(rerunOnlyResults(requirement, test, rerun({ "AC-1": "NOT_REACHED" }, { status: "ERRORED" })))).toEqual([
      ["AC-1", "INCONCLUSIVE", "RERUN_NOT_REACHED", null, "NOT_REACHED"],
      ["AC-2", "INCONCLUSIVE", "NOT_IN_GENERATED_TEST", null, "UNAVAILABLE"],
      ["AC-3", "INCONCLUSIVE", "RERUN_NOT_REACHED", null, "NOT_REACHED"],
    ]);
  });

  it("the verdict follows the critical criteria (AC-3 is not critical)", () => {
    const ok = rerunOnlyResults(
      requirement,
      { ...test, compiledCriteria: ["AC-1", "AC-3"], notCompiled: [] },
      rerun({ "AC-1": "PASSED", "AC-3": "ASSERTION_FAILED" }),
    );
    expect(aggregateVerdict(ok)).toBe("INCONCLUSIVE"); // AC-2 (critical, not compiled) is INCONCLUSIVE
    const onlyCompiled = { ...requirement, criteria: requirement.criteria.filter((c) => c.id !== "AC-2") };
    expect(aggregateVerdict(rerunOnlyResults(onlyCompiled, test, rerun({ "AC-1": "PASSED", "AC-3": "ASSERTION_FAILED" })))).toBe("PASSED");
  });
});
