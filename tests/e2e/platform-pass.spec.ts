import { afterAll, describe, expect, inject, it } from "vitest";
import { api, db, metricValue } from "./support/client";
import { REQUIREMENTS } from "./support/scenarios";
import { typecheckGeneratedTest } from "./support/typecheck";

const stack = inject("e2e");
const client = api(stack);
const store = db(stack);
afterAll(() => store.close());

describe("Task 21 step 1 — PASS", () => {
  it("search → add to cart → cart: completes PASSED; every criterion PASS confirmed by the Playwright rerun; the generated test typechecks", async () => {
    const runId = await client.create({ targetUrl: `${stack.shopUrl}/`, requirement: REQUIREMENTS.cart, options: { autoConfirmCriteria: true } });

    const done = await client.finished(runId);
    expect(done).toMatchObject({ lifecycle: "COMPLETED", verdict: "PASSED" });

    const report = await client.report(runId);
    expect(report.criteria.length).toBeGreaterThan(0);
    for (const c of report.criteria) expect(c).toMatchObject({ status: "PASS", verdictSource: "PLAYWRIGHT_RERUN", rerunOutcome: "PASSED" });
    expect(report.summary.confirmedByRerun).toBe(report.criteria.length);
    expect(report.playwright?.status).toBe("PASSED");

    const test = await store.generatedTest(runId);
    expect(test).not.toBeNull();
    expect([...test!.compiledCriteria].sort()).toEqual(report.criteria.map((c) => c.criterionId).sort());
    expect(await typecheckGeneratedTest(test!)).toBe("");

    // Task 22: the worker's metrics saw it.
    const metrics = await (await fetch(stack.workerMetricsUrl)).text();
    expect(metricValue(metrics, "test_runs_total", { lifecycle: "COMPLETED", verdict: "PASSED" })).toBeGreaterThanOrEqual(1);
    expect(metricValue(metrics, "test_run_duration_seconds_count", { stage: "EXPLORING" })).toBeGreaterThanOrEqual(1);
    expect(metricValue(metrics, "llm_requests_total", { stage: "PLANNING" })).toBeGreaterThanOrEqual(1);
  });
});
