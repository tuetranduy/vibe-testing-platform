import type { CriterionResult, TestReport } from "@platform/contracts";
import { describe, expect, it } from "vitest";
import { renderMarkdown, summarize, type BenchmarkCase, type CaseRun } from "./metrics";

const result = (criterionId: string, status: CriterionResult["status"], reason: CriterionResult["reason"] = null, verdictSource: CriterionResult["verdictSource"] = null) =>
  ({ criterionId, status, reason, verdictSource }) as CriterionResult;

const report = (verdict: TestReport["verdict"], criteria: CriterionResult[], over: Partial<TestReport> = {}): TestReport =>
  ({
    runId: "run",
    lifecycle: "COMPLETED",
    verdict,
    requirement: null,
    criteria,
    summary: {
      totalCriteria: criteria.length,
      passed: criteria.filter((c) => c.status === "PASS").length,
      failed: criteria.filter((c) => c.status === "FAIL").length,
      blocked: criteria.filter((c) => c.status === "BLOCKED").length,
      inconclusive: criteria.filter((c) => c.status === "INCONCLUSIVE").length,
      confirmedByRerun: criteria.filter((c) => c.verdictSource === "PLAYWRIGHT_RERUN").length,
      nonCritical: { total: 0, notPassed: 0 },
    },
    usage: { llmCalls: 3, inputTokens: 100, outputTokens: 10, estimatedCostUsd: 0.01 },
    durationMs: 60_000,
    ...over,
  }) as TestReport;

const cases: BenchmarkCase[] = [
  { id: "DS-01", site: "demo-shop", targetUrl: "http://demo-shop:4000/", requirement: "Add a product to the cart", expect: "PASSED" },
  { id: "DS-B1", site: "demo-shop", targetUrl: "http://demo-shop:4000/?bug=wrong_total", requirement: "Check the cart total", expect: "FAILED", bug: "wrong_total" },
  { id: "DS-B2", site: "demo-shop", targetUrl: "http://demo-shop:4000/?bug=empty_cart", requirement: "Check the cart lists it", expect: "FAILED", bug: "empty_cart" },
  { id: "FD-03", site: "frontends-demo", targetUrl: "https://frontends-demo.vercel.app/", requirement: "Test the search", expect: "ANY" },
];

const run = (caseId: string, rep: TestReport | null, repeat = 1): CaseRun => ({ caseId, repeat, runId: `run_${caseId}_${repeat}`, lifecycle: rep?.lifecycle ?? "ERRORED", report: rep });

describe("summarize", () => {
  const runs = [
    run("DS-01", report("PASSED", [result("AC-1", "PASS", null, "PLAYWRIGHT_RERUN")])),
    run("DS-B1", report("FAILED", [result("AC-1", "FAIL", null, "PLAYWRIGHT_RERUN")])),
    run("DS-B2", report("PASSED", [result("AC-1", "PASS", null, "EXPLORATION_ONLY")])),
    run("FD-03", report("INCONCLUSIVE", [result("AC-1", "INCONCLUSIVE", "FACT_NOT_OBSERVED")])),
  ];

  it("a bug case FAILED is caught; PASSED is a false pass", () => {
    const s = summarize(cases, runs);
    expect([s.bugsCaught, s.bugRuns, s.falsePasses]).toEqual([1, 2, 1]);
  });

  it("a healthy case FAILED is a false fail", () => {
    const s = summarize(cases, [...runs, run("DS-01", report("FAILED", [result("AC-1", "FAIL")]), 2)]);
    expect([s.falseFails, s.healthyRuns]).toEqual([1, 2]);
  });

  it("decided rate over all criteria, rerun-confirmed share of the decided, reasons of the undecided, cost and duration", () => {
    const s = summarize(cases, runs);
    expect(s.criteria).toEqual({ total: 4, pass: 2, fail: 1, blocked: 0, inconclusive: 1 });
    expect(s.decidedRate).toBeCloseTo(3 / 4);
    expect(s.rerunConfirmedRate).toBeCloseTo(2 / 3);
    expect(s.undecidedReasons).toEqual({ FACT_NOT_OBSERVED: 1 });
    expect(s.verdicts).toEqual({ PASSED: 2, FAILED: 1, INCONCLUSIVE: 1 });
    expect(s.costUsd).toBeCloseTo(0.04);
    expect(s.medianDurationS).toBe(60);
  });

  it("a run without a report is errored; a case whose repeats differ is unstable", () => {
    const s = summarize(cases, [...runs, run("DS-01", null, 2)]);
    expect(s.errored).toBe(1);
    expect(s.perCase.find((c) => c.id === "DS-01")).toMatchObject({ verdicts: ["PASSED", null], stable: false });
    expect(s.perCase.find((c) => c.id === "DS-B1")).toMatchObject({ verdicts: ["FAILED"], stable: true });
  });

  it("a run with no report still counts as an attempt: never met, never a caught bug (review finding)", () => {
    const s = summarize(cases, [run("DS-B1", report("FAILED", [result("AC-1", "FAIL")])), run("DS-B1", null, 2), run("DS-01", null)]);
    expect([s.expectationMet, s.expectationRuns]).toEqual([1, 3]);
    expect([s.bugsCaught, s.bugRuns]).toEqual([1, 2]);
    expect(s.healthyRuns).toBe(1);
  });

  it("counts passes on one broad check", () => {
    const shallow = report("PASSED", [result("AC-1", "PASS", null, "AI_JUDGMENT")], {
      requirement: { intent: { clarity: "site_wide", goal: "The site works", feature: null, notes: [] }, criteria: [{ id: "AC-1", critical: true }] } as unknown as TestReport["requirement"],
    });
    expect(summarize(cases, [run("FD-03", shallow)]).shallowPasses).toBe(1);
  });
});

describe("renderMarkdown", () => {
  it("prints the headline table and the cases; with a previous summary, a change column", () => {
    const now = summarize(cases, [run("DS-B1", report("FAILED", [result("AC-1", "FAIL")]))]);
    const before = summarize(cases, [run("DS-B1", report("PASSED", [result("AC-1", "PASS")]))]);
    const md = renderMarkdown(now);
    expect(md).toContain("| Bugs caught | 1 / 1 |");
    expect(md).toContain("| DS-B1 | demo-shop | FAILED | FAILED | yes |");
    const compared = renderMarkdown(now, before);
    expect(compared).toContain("| Metric | Value | Before | Change |");
    expect(compared).toContain("| Bugs caught | 1 / 1 | 0 / 1 | +1 |");
  });
});
