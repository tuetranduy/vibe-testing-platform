import {
  ProvisionalResultSchema,
  type AcceptanceCriterion,
  type ExplorationOutcome,
  type FactRef,
  type NormalizedRequirement,
  type ObservedFact,
  type TestPlan,
} from "@platform/contracts";
import { describe, expect, it } from "vitest";
import { createFakeStages } from "./fake-stages";
import { createRealStages } from "./real-stages";
import type { StageContext } from "./stages";

const before = { key: "cartCount", checkpoint: "before_add" };
const after = { key: "cartCount", checkpoint: "after_add" };
const title = { key: "pageTitle", checkpoint: "after_add" };
const SECRET = "pw-Hunter2-Secret";

const criterion = (id: string, expectedOutcome: AcceptanceCriterion["expectedOutcome"]): AcceptanceCriterion => ({
  id,
  sourceText: "x",
  statement: `stmt ${id}`,
  expectedOutcome,
  preconditions: [],
  ambiguity: null,
});
const requirement = {
  runId: "run_1",
  revision: 1,
  originalText: "x",
  criteria: [
    criterion("AC-1", { kind: "numeric_compare", left: after, operator: "gt", right: before }),
    criterion("AC-2", { kind: "text_matches", fact: title, match: { mode: "contains", value: "Added", caseSensitive: false } }),
    criterion("AC-3", { kind: "numeric_compare", left: after, operator: "eq", right: 1 }),
  ],
  facts: [],
  confirmedAt: "2026-09-26T10:00:00.000Z",
} as NormalizedRequirement;
const plan: TestPlan = {
  runId: "run_1",
  requirementRevision: 1,
  scenarios: [
    {
      id: "SC-1",
      title: "Cart",
      criterionIds: ["AC-1", "AC-2", "AC-3"],
      steps: [
        { id: "PS-1", kind: "capture_checkpoint", description: "Capture before", checkpoint: "before_add", criterionIds: [], destructive: false },
        { id: "PS-2", kind: "click", description: "Add to cart", criterionIds: [], destructive: false },
        { id: "PS-3", kind: "capture_checkpoint", description: "Capture after", checkpoint: "after_add", criterionIds: [], destructive: false },
      ],
    },
  ],
  blockedCriteria: [{ criterionId: "AC-3", reason: "MISSING_SECRET", detail: "no password" }],
  stopConditions: [],
};
const element = { candidates: [{ strategy: "testId" as const, value: "cart-count" }], chosenIndex: 0, framePath: [] };
const fact = (ref: FactRef, value: ObservedFact["value"], provenance: ObservedFact["provenance"] = "DOM_VERIFIED"): ObservedFact => ({
  ...ref,
  value,
  provenance,
  read: provenance === "DOM_VERIFIED" ? { element, mode: "number" } : null,
  stepId: "st_1",
});
const exploration = (facts: ObservedFact[]): ExplorationOutcome => ({ steps: [], facts, stopReason: "COMPLETED" });

const llm = { generateStructured: async () => ({}) as never };
const explorationDeps = { openSandbox: async () => ({}) as never, explorer: { start: async () => ({}) as never }, store: () => ({}) as never };
const ctx = {
  runId: "run_1",
  request: { targetUrl: "https://shop.example.com" },
  now: () => new Date("2026-09-26T10:00:00.000Z"),
  redact: (v: unknown) => JSON.parse(JSON.stringify(v).replaceAll(SECRET, "[REDACTED]")),
} as unknown as StageContext;
const stagesWith = (status?: "PASS" | "FAIL") =>
  createRealStages({ llm, exploration: explorationDeps }, createFakeStages(status ? { provisionalStatus: status } : {}));

describe("createRealStages: verify (Task 15)", () => {
  it("verifies every criterion from the recorded facts; a fallback configured to PASS/FAIL has no say", () => {
    for (const status of ["PASS", "FAIL"] as const) {
      const results = stagesWith(status).verify(ctx, requirement, plan, exploration([fact(before, 1), fact(after, 1), fact(title, "Added to cart")]));
      expect(results.map((r) => [r.criterionId, r.status, r.reason])).toEqual([
        ["AC-1", "FAIL", null],
        ["AC-2", "PASS", null],
        ["AC-3", "BLOCKED", "MISSING_SECRET"],
      ]);
      for (const r of results) ProvisionalResultSchema.parse(r);
    }
  });

  it("all-blocked path (exploration null): every criterion is plan-blocked", () => {
    const allBlocked = { ...plan, blockedCriteria: requirement.criteria.map((c) => ({ criterionId: c.id, reason: "MISSING_SECRET" as const, detail: "no password" })) };
    const results = stagesWith().verify(ctx, requirement, allBlocked, null);
    expect(results.map((r) => [r.status, r.reason])).toEqual(Array(3).fill(["BLOCKED", "MISSING_SECRET"]));
  });

  it("expected / actual pass through the run's redactor (facts can contain page text)", () => {
    const withSecret = { ...requirement, criteria: [criterion("AC-2", { kind: "text_matches", fact: title, match: { mode: "contains", value: SECRET, caseSensitive: false } })] };
    const [r] = stagesWith().verify(ctx, withSecret, { ...plan, blockedCriteria: [] }, exploration([fact(title, `Your password is ${SECRET}`)]));
    expect(r!.status).toBe("PASS");
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(r!.actual).toBe('Page title after add is "Your password is [REDACTED]"');
  });
});

describe("createRealStages: interim report (Ruling R26, until Task 18)", () => {
  const input = (facts: ObservedFact[]) => {
    const exp = exploration(facts);
    const provisional = stagesWith().verify(ctx, requirement, plan, exp);
    return { requirement, plan, exploration: exp, provisional, generatedTest: null, rerun: null, startedAt: null };
  };

  it("a PASS/FAIL backed only by DOM_VERIFIED facts stands as EXPLORATION_ONLY", async () => {
    const report = await stagesWith().report(ctx, input([fact(before, 0), fact(after, 1), fact(title, "Added")]));
    expect(report.criteria.map((c) => [c.criterionId, c.status, c.reason, c.verdictSource])).toEqual([
      ["AC-1", "PASS", null, "EXPLORATION_ONLY"],
      ["AC-2", "PASS", null, "EXPLORATION_ONLY"],
      ["AC-3", "BLOCKED", "MISSING_SECRET", null],
    ]);
    expect(report.verdict).toBe("BLOCKED");
  });

  it("a PASS/FAIL with any MODEL_EXTRACTED fact → INCONCLUSIVE / UNVERIFIED_EVIDENCE; the provisional status is kept for the record", async () => {
    const report = await stagesWith().report(ctx, input([fact(before, 0), fact(after, 1, "MODEL_EXTRACTED"), fact(title, "Added")]));
    expect(report.criteria[0]).toMatchObject({
      criterionId: "AC-1",
      status: "INCONCLUSIVE",
      reason: "UNVERIFIED_EVIDENCE",
      verdictSource: null,
      rerunOutcome: "UNAVAILABLE",
      provisional: { status: "PASS", reason: null },
    });
    expect(report.criteria[1]).toMatchObject({ status: "PASS", verdictSource: "EXPLORATION_ONLY", provisional: { status: "PASS", reason: null } });
    expect(report.summary).toMatchObject({ passed: 1, inconclusive: 1, blocked: 1 });
  });
});
