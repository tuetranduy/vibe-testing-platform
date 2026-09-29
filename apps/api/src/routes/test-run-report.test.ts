import {
  TestReportSchema,
  type CriterionResult,
  type ExplorationStep,
  type NormalizedRequirement,
  type ObservedFact,
  type ProvisionalResult,
  type RunLifecycle,
  type TestPlan,
} from "@platform/contracts";
import {
  DiagnosticFindingRepository,
  EventRepository,
  ExplorationStepRepository,
  GeneratedTestRepository,
  LlmCallRepository,
  ObservedFactRepository,
  PlanRepository,
  RequirementRepository,
  ResultRepository,
  RunRepository,
  type TestRun,
} from "@platform/db";
import { OTHER_TENANT_ID, TEST_TENANT_ID } from "@platform/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, createTestApi, type TestApi } from "../test-support";

let t: TestApi;
beforeAll(async () => {
  t = await createTestApi();
});
afterAll(async () => t?.close());

const request = {
  targetUrl: "https://shop.example.com",
  requirement: "A user can add a product to the cart. The cart count should increase.",
  environment: "staging" as const,
  browser: "chromium" as const,
  testData: {},
  secretNames: [],
  options: {} as never,
};

const before = { key: "cartCount", checkpoint: "before_add" };
const after = { key: "cartCount", checkpoint: "after_add" };
const items = { key: "cartItems", checkpoint: "cart_page" };
const draft: Omit<NormalizedRequirement, "runId" | "revision" | "confirmedAt"> = {
  originalText: request.requirement,
  criteria: [
    {
      id: "AC-1",
      sourceText: "The cart count should increase.",
      statement: "The cart count increases",
      expectedOutcome: { kind: "numeric_compare", left: after, operator: "gt", right: before },
      preconditions: [],
      critical: true,
      ambiguity: null,
    },
    {
      id: "AC-2",
      sourceText: "A user can add a product to the cart.",
      statement: "The cart lists the product",
      expectedOutcome: { kind: "collection_contains", collection: items, item: "iPhone", match: "contains" },
      preconditions: [],
      critical: true,
      ambiguity: null,
    },
  ],
  facts: [
    { ...before, description: "Cart badge count", valueType: "number" },
    { ...after, description: "Cart badge count", valueType: "number" },
    { ...items, description: "Cart items", valueType: "string_list" },
  ],
};

const PATHS: Record<string, RunLifecycle[]> = {
  COMPLETED: ["ANALYZING_REQUIREMENT", "PLANNING", "EXPLORING", "VERIFYING", "GENERATING_TEST", "RUNNING_PLAYWRIGHT", "GENERATING_REPORT", "COMPLETED"],
  ERRORED: ["ANALYZING_REQUIREMENT", "PLANNING", "EXPLORING", "VERIFYING", "GENERATING_REPORT", "ERRORED"],
  CANCELLED: ["ANALYZING_REQUIREMENT", "AWAITING_CONFIRMATION", "CANCELLED"],
  AWAITING_CONFIRMATION: ["ANALYZING_REQUIREMENT", "AWAITING_CONFIRMATION"],
  RUNNING_PLAYWRIGHT: ["ANALYZING_REQUIREMENT", "PLANNING", "EXPLORING", "VERIFYING", "GENERATING_TEST", "RUNNING_PLAYWRIGHT"],
  GENERATING_REPORT: ["ANALYZING_REQUIREMENT", "PLANNING", "EXPLORING", "VERIFYING", "GENERATING_REPORT"],
};

/**
 * A run walked through the state machine to `target` (QUEUED stays put). Its criteria are compiled
 * while ANALYZING_REQUIREMENT and confirmed before PLANNING, as the worker does.
 */
async function runAt(target: RunLifecycle, tenantId = TEST_TENANT_ID): Promise<TestRun> {
  const runs = new RunRepository(t.tdb.db);
  const reqs = new RequirementRepository(t.tdb.db);
  let run = await runs.create({ tenantId, targetUrl: request.targetUrl, request });
  let from: RunLifecycle = "QUEUED";
  for (const to of PATHS[target] ?? []) {
    if (to === "PLANNING") await reqs.confirm(run.id, 1);
    const patch =
      to === "COMPLETED" ? { verdict: "FAILED" as const }
      : to === "ERRORED" ? { errorCategory: "TIMEOUT" as const, errorMessage: "The run exceeded its deadline" }
      : to === "CANCELLED" ? { cancelReason: "USER_REQUESTED" as const }
      : {};
    run = await runs.transition(run.id, from, to, patch);
    if (to === "ANALYZING_REQUIREMENT") await reqs.createRevision(run.id, draft);
    if (to === "PLANNING") await runs.markExecutionStarted(run.id, { startedAt: new Date(Date.now() - 60_000), deadlineAt: new Date(Date.now() + 60_000) });
    from = to;
  }
  return runs.getById(run.id);
}

const step = (runId: string, index: number, plannedStepId: string, artifactIds: string[]): ExplorationStep => ({
  id: `st_${runId}_${index}`,
  runId,
  index,
  plannedStepId,
  kind: "checkpoint",
  instruction: `Capture ${plannedStepId}`,
  element: null,
  inputRef: null,
  onGoldenPath: true,
  urlBefore: "https://shop.example.com/",
  urlAfter: "https://shop.example.com/",
  outcome: "SUCCESS",
  blockReason: null,
  error: null,
  startedAt: new Date().toISOString(),
  durationMs: 1,
  artifactIds,
  llm: null,
});
const element = { candidates: [{ strategy: "testId" as const, value: "x" }], chosenIndex: 0, framePath: [] };
const fact = (ref: { key: string; checkpoint: string }, value: ObservedFact["value"], stepId: string, provenance: ObservedFact["provenance"] = "DOM_VERIFIED"): ObservedFact => ({
  ...ref,
  value,
  provenance,
  read: provenance === "DOM_VERIFIED" ? { element, mode: "number" } : null,
  stepId,
});
const provisional = (criterionId: string, status: ProvisionalResult["status"], factRefs: { key: string; checkpoint: string }[]): ProvisionalResult => ({
  criterionId,
  status,
  reason: null,
  factRefs,
  expected: `Expected ${criterionId}`,
  actual: `Actual ${criterionId}`,
});

/** Plan, three exploration steps and their facts (cartItems only MODEL_EXTRACTED). */
async function seedExploration(runId: string) {
  const plan: TestPlan = {
    runId,
    requirementRevision: 1,
    scenarios: [
      {
        id: "SC-1",
        title: "Cart",
        criterionIds: ["AC-1", "AC-2"],
        steps: [
          { id: "PS-1", kind: "capture_checkpoint", description: "Capture before", checkpoint: "before_add", criterionIds: [], destructive: false },
          { id: "PS-2", kind: "capture_checkpoint", description: "Capture after", checkpoint: "after_add", criterionIds: ["AC-1"], destructive: false },
          { id: "PS-3", kind: "capture_checkpoint", description: "Capture cart", checkpoint: "cart_page", criterionIds: [], destructive: false },
        ],
      },
    ],
    blockedCriteria: [],
    stopConditions: [],
  };
  await new PlanRepository(t.tdb.db).save(plan);
  const steps = [step(runId, 0, "PS-1", ["art_s0"]), step(runId, 1, "PS-2", ["art_s1"]), step(runId, 2, "PS-3", ["art_s2"])];
  for (const s of steps) await new ExplorationStepRepository(t.tdb.db).insert(s);
  const facts = new ObservedFactRepository(t.tdb.db);
  await facts.upsert(runId, fact(before, 0, steps[0]!.id));
  await facts.upsert(runId, fact(after, 1, steps[1]!.id));
  await facts.upsert(runId, fact(items, ["iPhone 17 Pro"], steps[2]!.id, "MODEL_EXTRACTED"));
  return steps;
}

const getReport = (runId: string) => t.app.inject({ method: "GET", url: `/v1/test-runs/${runId}/report`, headers: auth });

describe("GET /v1/test-runs/:runId/report", () => {
  it("COMPLETED → the full report from persisted data", async () => {
    const run = await runAt("COMPLETED");
    const steps = await seedExploration(run.id);
    const final: CriterionResult[] = [
      {
        ...provisional("AC-1", "FAIL", [after, before]),
        verdictSource: "PLAYWRIGHT_RERUN",
        rerunOutcome: "ASSERTION_FAILED",
        provisional: { status: "FAIL", reason: null },
        evidenceArtifactIds: ["art_trace", "art_s1"],
        relatedStepIds: [steps[1]!.id],
        aiNote: null,
        critical: true,
      },
      {
        ...provisional("AC-2", "INCONCLUSIVE", [items]),
        reason: "UNVERIFIED_EVIDENCE",
        actual: null,
        verdictSource: null,
        rerunOutcome: "UNAVAILABLE",
        provisional: { status: "PASS", reason: null },
        evidenceArtifactIds: ["art_s2"],
        relatedStepIds: [steps[2]!.id],
        aiNote: null,
        critical: true,
      },
    ];
    for (const r of final) await new ResultRepository(t.tdb.db).upsert(run.id, r);
    await new GeneratedTestRepository(t.tdb.db).save(run.id, {
      id: `gt_${run.id}`,
      source: "// test",
      helpersSource: "// helpers",
      dataJson: '{"inputs":{}}',
      compiledCriteria: ["AC-1"],
      notCompiled: [{ criterionId: "AC-2", reason: "Fact cartItems@cart_page was extracted by the model, not read from the page" }],
      notes: [],
    });
    await new EventRepository(t.tdb.db).append({ runId: run.id, stage: "RUNNING_PLAYWRIGHT", type: "playwright.completed", message: "Playwright rerun failed", payload: { status: "FAILED", durationMs: 4321, perCriterion: { "AC-1": "ASSERTION_FAILED" } } });
    await new DiagnosticFindingRepository(t.tdb.db).insertMany(run.id, [{ criterionId: "AC-1", summary: "The badge did not change." }]);
    const calls = new LlmCallRepository(t.tdb.db);
    const call = { runId: run.id, provider: "fake", model: "m", latencyMs: 5, status: "SUCCESS" };
    await calls.create({ ...call, stage: "ANALYZING_REQUIREMENT", inputTokens: 1200, outputTokens: 300, estimatedCostUsd: 0.0054 });
    await calls.create({ ...call, stage: "PLANNING", inputTokens: 2000, outputTokens: 500, estimatedCostUsd: 0.0135 });

    const res = await getReport(run.id);
    expect(res.statusCode).toBe(200);
    const report = TestReportSchema.parse(res.json());
    expect(report).toMatchObject({
      runId: run.id,
      lifecycle: "COMPLETED",
      verdict: "FAILED",
      partial: false,
      error: null,
      targetUrl: "https://shop.example.com",
      summary: { totalCriteria: 2, passed: 0, failed: 1, blocked: 0, inconclusive: 1, confirmedByRerun: 1 },
      playwright: { status: "FAILED", durationMs: 4321 },
      diagnostics: [{ criterionId: "AC-1", summary: "The badge did not change." }],
      usage: { llmCalls: 2, inputTokens: 3200, outputTokens: 800, estimatedCostUsd: 0.0189 },
    });
    expect(report.requirement?.criteria.map((c) => c.id)).toEqual(["AC-1", "AC-2"]);
    expect(report.criteria).toEqual(final);
    expect(report.generatedTest).toEqual({
      id: `gt_${run.id}`,
      source: "// test",
      compiledCriteria: ["AC-1"],
      notCompiled: [{ criterionId: "AC-2", reason: "Fact cartItems@cart_page was extracted by the model, not read from the page" }],
      notes: [],
    });
    expect(JSON.stringify(res.json())).not.toContain("helpers");
    expect(report.startedAt).not.toBeNull();
    expect(report.durationMs).toBeGreaterThan(0);
  });

  it("ERRORED → partial: whatever exists; provisional-only results are reconciled with rerun UNAVAILABLE (no PASS without deterministic evidence)", async () => {
    const run = await runAt("ERRORED");
    const steps = await seedExploration(run.id);
    await new ResultRepository(t.tdb.db).upsert(run.id, provisional("AC-1", "PASS", [after, before]));
    await new ResultRepository(t.tdb.db).upsert(run.id, provisional("AC-2", "PASS", [items]));

    const res = await getReport(run.id);
    expect(res.statusCode).toBe(200);
    const report = TestReportSchema.parse(res.json());
    expect(report).toMatchObject({
      lifecycle: "ERRORED",
      partial: true,
      verdict: null,
      error: { category: "TIMEOUT", message: "The run exceeded its deadline" },
      playwright: null,
      diagnostics: [],
      generatedTest: null,
      usage: { llmCalls: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
    });
    expect(report.criteria.map((c) => [c.criterionId, c.status, c.reason, c.verdictSource, c.rerunOutcome])).toEqual([
      ["AC-1", "PASS", null, "EXPLORATION_ONLY", "UNAVAILABLE"],
      ["AC-2", "INCONCLUSIVE", "UNVERIFIED_EVIDENCE", null, "UNAVAILABLE"],
    ]);
    expect(report.criteria[0]).toMatchObject({ relatedStepIds: [steps[0]!.id, steps[1]!.id], evidenceArtifactIds: ["art_s0", "art_s1"] });
  });

  it("ERRORED after a rerun → each criterion's outcome comes from the persisted playwright.completed event (Ruling R43)", async () => {
    // e.g. the hard deadline hit during GENERATING_REPORT: only provisional rows were saved, but the rerun had run.
    const run = await runAt("ERRORED");
    await seedExploration(run.id);
    await new ResultRepository(t.tdb.db).upsert(run.id, provisional("AC-1", "PASS", [after, before]));
    await new ResultRepository(t.tdb.db).upsert(run.id, provisional("AC-2", "PASS", [items]));
    await new EventRepository(t.tdb.db).append({
      runId: run.id,
      stage: "RUNNING_PLAYWRIGHT",
      type: "playwright.completed",
      message: "Playwright rerun failed",
      payload: { status: "FAILED", durationMs: 99, perCriterion: { "AC-1": "ASSERTION_FAILED" } },
    });

    const report = TestReportSchema.parse((await getReport(run.id)).json());
    expect(report).toMatchObject({ partial: true, verdict: null, playwright: { status: "FAILED", durationMs: 99 } });
    // The DOM-backed PASS the rerun failed is a disagreement — never PASS / EXPLORATION_ONLY next to a failed rerun.
    expect(report.criteria.map((c) => [c.criterionId, c.status, c.reason, c.verdictSource, c.rerunOutcome])).toEqual([
      ["AC-1", "INCONCLUSIVE", "DISCOVERY_RERUN_DISAGREE", null, "ASSERTION_FAILED"],
      ["AC-2", "INCONCLUSIVE", "UNVERIFIED_EVIDENCE", null, "UNAVAILABLE"],
    ]);
  });

  it("CANCELLED → partial with whatever exists (here: the unconfirmed criteria, no results)", async () => {
    const run = await runAt("CANCELLED");
    const res = await getReport(run.id);
    expect(res.statusCode).toBe(200);
    const report = TestReportSchema.parse(res.json());
    expect(report).toMatchObject({ lifecycle: "CANCELLED", partial: true, verdict: null, error: null, criteria: [], playwright: null });
    expect(report.requirement?.criteria).toHaveLength(2);
    expect(report.summary.totalCriteria).toBe(0);
  });

  it.each(["QUEUED", "AWAITING_CONFIRMATION", "RUNNING_PLAYWRIGHT", "GENERATING_REPORT"] as const)("a %s run → 409 REPORT_NOT_READY", async (lifecycle) => {
    const run = await runAt(lifecycle);
    const res = await getReport(run.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("REPORT_NOT_READY");
  });

  it("another tenant's run → 404; an unknown run → 404", async () => {
    const run = await runAt("COMPLETED", OTHER_TENANT_ID);
    expect((await getReport(run.id)).statusCode).toBe(404);
    expect((await getReport("run_does_not_exist")).statusCode).toBe(404);
  });

  it("requires the bearer token", async () => {
    const run = await runAt("COMPLETED");
    expect((await t.app.inject({ method: "GET", url: `/v1/test-runs/${run.id}/report` })).statusCode).toBe(401);
  });
});
