import {
  ContractError,
  ProvisionalResultSchema,
  RerunResultSchema,
  type RerunResult,
  type AcceptanceCriterion,
  type ExplorationOutcome,
  type FactRef,
  type NormalizedRequirement,
  type ObservedFact,
  type TestPlan,
} from "@platform/contracts";
import type { LlmClient } from "@platform/llm";
import { describe, expect, it } from "vitest";
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
  facts: [
    { ...before, description: "Cart badge count", valueType: "number" },
    { ...after, description: "Cart badge count", valueType: "number" },
    { ...title, description: "Page title", valueType: "string" },
  ],
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

const explorationDeps = { openSandbox: async () => ({}) as never, explorer: { start: async () => ({}) as never }, store: () => ({}) as never };
const generateTestDeps = { store: () => ({ save: async () => {} }) };
/** A rerun whose egress proxy cannot start: the stage must answer ERRORED without running anything. */
const runTestDeps = {
  openProxy: async () => Promise.reject(new Error("proxy unavailable")),
  spawn: async () => Promise.reject(new Error("never spawned")),
  workspace: { baseDir: "/nonexistent-rerun-workspaces" },
  evidence: () => ({ save: async () => ({ artifactId: "art_never" }) }),
};
const ctx = {
  runId: "run_1",
  request: { targetUrl: "https://shop.example.com" },
  signal: new AbortController().signal,
  secrets: { names: [], get: () => undefined },
  addCleanup: () => {},
  now: () => new Date("2026-09-26T10:00:00.000Z"),
  redact: (v: unknown) => JSON.parse(JSON.stringify(v).replaceAll(SECRET, "[REDACTED]")),
} as unknown as StageContext;
const reportDeps = { store: () => ({ saveDiagnostics: async () => {}, llmUsage: async () => [] }) };
const stagesWith = () =>
  createRealStages({ survey: { openSandbox: async () => ({}) as never, store: () => ({}) as never }, exploration: explorationDeps, generateTest: generateTestDeps, runTest: runTestDeps, report: reportDeps });

describe("createRealStages: the run's model client (StageContext.llm)", () => {
  /** A client that records which stage called it, then stops the stage. */
  const recording = () => {
    const calls: string[] = [];
    const client = {
      generateStructured: async (input: { stage: string }) => {
        calls.push(input.stage);
        throw new Error("stopped after the call");
      },
    } as unknown as LlmClient;
    return { calls, client };
  };
  const runCtx = (llm: LlmClient | null) =>
    ({ ...ctx, request: { ...ctx.request, requirement: "A user can add a product to the cart.", testData: {}, options: { allowDestructiveActions: false } }, llm }) as unknown as StageContext;

  it("analyze and plan call the run's client", async () => {
    const { calls, client } = recording();
    await expect(stagesWith().analyze(runCtx(client))).rejects.toThrow("stopped after the call");
    await expect(stagesWith().plan(runCtx(client), requirement)).rejects.toThrow("stopped after the call");
    expect(calls).toEqual(["ANALYZING_REQUIREMENT", "PLANNING"]);
  });

  it("a run without a client (the fake engine's choice) fails with ContractError before any model call", async () => {
    await expect(stagesWith().analyze(runCtx(null))).rejects.toBeInstanceOf(ContractError);
    await expect(stagesWith().plan(runCtx(null), requirement)).rejects.toBeInstanceOf(ContractError);
  });
});

describe("createRealStages: verify (Task 15)", () => {
  it("verifies every criterion from the recorded facts", () => {
    const results = stagesWith().verify(ctx, requirement, plan, exploration([fact(before, 1), fact(after, 1), fact(title, "Added to cart")]));
    expect(results.map((r) => [r.criterionId, r.status, r.reason])).toEqual([
      ["AC-1", "FAIL", null],
      ["AC-2", "PASS", null],
      ["AC-3", "BLOCKED", "MISSING_SECRET"],
    ]);
    for (const r of results) ProvisionalResultSchema.parse(r);
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

describe("createRealStages: report (Task 18)", () => {
  const input = (facts: ObservedFact[], rerun: RerunResult | null) => {
    const exp = exploration(facts);
    const provisional = stagesWith().verify(ctx, requirement, plan, exp);
    return { requirement, plan, exploration: exp, provisional, generatedTest: null, rerun, startedAt: null };
  };
  const dom = [fact(before, 0), fact(after, 1), fact(title, "Added")];

  it("reconciles the rerun: a confirmed PASS is PLAYWRIGHT_RERUN, a disagreeing rerun makes it INCONCLUSIVE (the interim R26 rule is gone, R35)", async () => {
    const rerun = { status: "FAILED" as const, perCriterion: { "AC-1": "ASSERTION_FAILED" as const, "AC-2": "PASSED" as const }, durationMs: 42, errorText: {}, artifactIds: ["art_1"] };
    const report = await stagesWith().report(ctx, input(dom, rerun));
    expect(report.criteria.map((c) => [c.criterionId, c.status, c.reason, c.verdictSource, c.rerunOutcome])).toEqual([
      ["AC-1", "INCONCLUSIVE", "DISCOVERY_RERUN_DISAGREE", null, "ASSERTION_FAILED"],
      ["AC-2", "PASS", null, "PLAYWRIGHT_RERUN", "PASSED"],
      ["AC-3", "BLOCKED", "MISSING_SECRET", null, "UNAVAILABLE"],
    ]);
    expect(report.criteria[0]!.provisional).toEqual({ status: "PASS", reason: null });
    expect(report.summary.confirmedByRerun).toBe(1);
    expect(report.playwright).toEqual({ status: "FAILED", durationMs: 42 });
    expect(report.verdict).toBe("BLOCKED");
  });

  it("no rerun: a PASS stands (EXPLORATION_ONLY) only on DOM_VERIFIED facts; MODEL_EXTRACTED evidence → INCONCLUSIVE / UNVERIFIED_EVIDENCE", async () => {
    const report = await stagesWith().report(ctx, input([fact(before, 0), fact(after, 1, "MODEL_EXTRACTED"), fact(title, "Added")], null));
    expect(report.criteria.map((c) => [c.criterionId, c.status, c.reason, c.verdictSource])).toEqual([
      ["AC-1", "INCONCLUSIVE", "UNVERIFIED_EVIDENCE", null],
      ["AC-2", "PASS", null, "EXPLORATION_ONLY"],
      ["AC-3", "BLOCKED", "MISSING_SECRET", null],
    ]);
  });
});

describe("createRealStages: runTest (Task 17)", () => {
  it("is the sandboxed rerun, never the fake: a rerun that cannot start is ERRORED, every compiled criterion NOT_REACHED", async () => {
    const test = { id: "gt_1", source: "", helpersSource: "", dataJson: "{}", compiledCriteria: ["AC-1", "AC-2"], notCompiled: [], notes: [] };
    const rerun = await stagesWith().runTest(ctx, test);
    expect(RerunResultSchema.parse(rerun)).toEqual({
      status: "ERRORED",
      perCriterion: { "AC-1": "NOT_REACHED", "AC-2": "NOT_REACHED" },
      durationMs: 0,
      errorText: { "AC-1": "The rerun's network guard could not be started", "AC-2": "The rerun's network guard could not be started" },
      artifactIds: [],
    });
  });
});
