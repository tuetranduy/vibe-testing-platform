import type { ExplorationStep, NormalizedRequirement, ProvisionalResult, TestPlan } from "@platform/contracts";
import { describe, expect, it } from "vitest";
import { reconcileCriteria } from "./report-builder";

const criterion = (id: string) => ({
  id,
  sourceText: "A user can sign in.",
  statement: `Criterion ${id}`,
  expectedOutcome: { kind: "visible" as const, fact: { key: "welcome", checkpoint: "after_login" }, expected: true },
  preconditions: [],
  critical: true,
  ambiguity: null,
});

const requirement: NormalizedRequirement = {
  runId: "run_1",
  revision: 1,
  originalText: "A user can sign in.",
  criteria: [criterion("AC-1"), criterion("AC-2")],
  facts: [{ key: "welcome", checkpoint: "after_login", description: "Welcome message", valueType: "boolean" }],
  confirmedAt: "2026-09-30T10:00:00.000Z",
};

const plan: TestPlan = {
  runId: "run_1",
  requirementRevision: 1,
  scenarios: [
    { id: "SC-1", title: "Sign in", criterionIds: ["AC-1"], steps: [{ id: "PS-1", kind: "navigate", description: "Open the login page", criterionIds: [], destructive: false }] },
    { id: "SC-2", title: "Other", criterionIds: ["AC-2"], steps: [{ id: "PS-2", kind: "navigate", description: "Open the home page", criterionIds: [], destructive: false }] },
  ],
  blockedCriteria: [],
  stopConditions: [],
};

const step = (id: string, patch: Partial<ExplorationStep>): ExplorationStep => ({
  id,
  runId: "run_1",
  index: 0,
  plannedStepId: "PS-1",
  kind: "fill",
  instruction: "x",
  element: null,
  inputRef: null,
  onGoldenPath: false,
  urlBefore: "https://shop.example.com/",
  urlAfter: "https://shop.example.com/",
  outcome: "SUCCESS",
  blockReason: null,
  error: null,
  startedAt: "2026-09-30T10:00:00.000Z",
  durationMs: 0,
  artifactIds: [],
  llm: null,
  ...patch,
});

const blocked = (criterionId: string): ProvisionalResult => ({
  criterionId,
  status: "BLOCKED",
  reason: "MISSING_SECRET",
  factRefs: [],
  expected: "x",
  actual: null,
});

describe("reconcileCriteria: evidence of blocked criteria and recordings (V1.3)", () => {
  it("a blocked criterion keeps the screenshot of where its scenario was blocked, not another scenario's", () => {
    const steps = [
      step("st_1", { index: 0, outcome: "BLOCKED_BY_POLICY", blockReason: "MISSING_SECRET", artifactIds: ["art_blocked_sc1"], scenarioId: "SC-1" }),
      step("st_2", { index: 1, plannedStepId: "PS-2", outcome: "BLOCKED_BY_POLICY", blockReason: "MISSING_SECRET", artifactIds: ["art_blocked_sc2"], scenarioId: "SC-2" }),
    ];
    const [ac1, ac2] = reconcileCriteria({ requirement, plan, steps, facts: [], results: [blocked("AC-1"), blocked("AC-2")], rerun: null });
    expect(ac1!.evidenceArtifactIds).toEqual(["art_blocked_sc1"]);
    expect(ac2!.evidenceArtifactIds).toEqual(["art_blocked_sc2"]);
  });

  it("every criterion blocked before exploration: the start page's screenshot step is their evidence", () => {
    const shot = step("st_shot", { plannedStepId: null, kind: "screenshot", artifactIds: ["art_start"] });
    const results = reconcileCriteria({ requirement, plan, steps: [shot], facts: [], results: [blocked("AC-1"), blocked("AC-2")], rerun: null });
    expect(results.map((r) => r.evidenceArtifactIds)).toEqual([["art_start"], ["art_start"]]);
  });

  it("a criterion that is not blocked does not take blocked steps' screenshots; the recordings come last for every criterion", () => {
    const steps = [step("st_1", { outcome: "BLOCKED_BY_POLICY", blockReason: "MISSING_SECRET", artifactIds: ["art_blocked"], scenarioId: "SC-1" })];
    const inconclusive: ProvisionalResult = { ...blocked("AC-1"), status: "INCONCLUSIVE", reason: "FACT_NOT_OBSERVED" };
    const [ac1, ac2] = reconcileCriteria({
      requirement,
      plan,
      steps,
      facts: [],
      results: [inconclusive, blocked("AC-2")],
      rerun: null,
      recordingArtifactIds: ["art_video", "art_trace"],
    });
    expect(ac1!.evidenceArtifactIds).toEqual(["art_video", "art_trace"]);
    expect(ac2!.evidenceArtifactIds).toEqual(["art_video", "art_trace"]);
  });
});
