import type { CriterionResult, CriterionStatus } from "@platform/contracts";
import { RequirementRepository, ResultRepository, RunRepository } from "@platform/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, confirmedRequirement, createTestApi, finishedRunWithTest, signInMember, type TestApi } from "../test-support";

let t: TestApi;
beforeAll(async () => {
  t = await createTestApi();
});
afterAll(async () => t?.close());

const call = (url: string, headers: Record<string, string> = auth) => t.app.inject({ method: "GET", url, headers });
const post = (url: string, payload: object, headers: Record<string, string> = auth) => t.app.inject({ method: "POST", url, headers, payload });

const result = (status: CriterionStatus): CriterionResult => ({
  criterionId: "AC-1",
  status,
  reason: status === "PASS" || status === "FAIL" ? null : "RERUN_NOT_REACHED",
  factRefs: [],
  expected: "The cart count is 1",
  actual: status === "PASS" ? "1" : "0",
  verdictSource: status === "PASS" || status === "FAIL" ? "PLAYWRIGHT_RERUN" : null,
  rerunOutcome: status === "PASS" ? "PASSED" : "ASSERTION_FAILED",
  provisional: { status, reason: null },
  evidenceArtifactIds: [],
  relatedStepIds: [],
  aiNote: null,
  critical: true,
});

/** Completes a QUEUED run (created by the API) with one criterion result. */
async function complete(runId: string, status: CriterionStatus) {
  const runs = new RunRepository(t.tdb.db);
  if (!(await new RequirementRepository(t.tdb.db).findLatest(runId))) {
    await new RequirementRepository(t.tdb.db).copyConfirmed(runId, confirmedRequirement(runId));
  }
  await new ResultRepository(t.tdb.db).upsert(runId, result(status));
  await runs.transition(runId, "QUEUED", "RUNNING_PLAYWRIGHT");
  await runs.transition(runId, "RUNNING_PLAYWRIGHT", "GENERATING_REPORT");
  await runs.transition(runId, "GENERATING_REPORT", "COMPLETED", { verdict: status === "PASS" ? "PASSED" : "FAILED" });
}

const create = async (requirement: string, headers: Record<string, string> = auth) =>
  (await post("/v1/test-runs", { targetUrl: "https://shop.example.com", requirement }, headers)).json().runId as string;

describe("GET /v1/test-runs/:runId/comparison (V1.2 F2)", () => {
  it("compares with the previous completed run of the same test and lists the others", async () => {
    const text = `Compare the cart count ${Date.now()}`;
    const first = await create(text);
    await complete(first, "PASS");
    const other = await create(`${text} but different`);
    await complete(other, "PASS");
    const latest = await create(`  ${text.replace(/ /g, "\n")} `);
    await complete(latest, "FAIL");

    const res = await call(`/v1/test-runs/${latest}/comparison`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      runId: latest,
      baseline: { runId: first },
      chosenBaseline: false,
      verdict: { before: "PASSED", after: "FAILED" },
      criteria: [{ id: "AC-1", description: "The cart count is 1", before: "PASS", after: "FAIL", change: "regressed" }],
      counts: { regressed: 1 },
      history: [{ runId: first, verdict: "PASSED" }],
    });
    expect((await call(`/v1/test-runs/${first}/comparison`)).json()).toMatchObject({ baseline: null, criteria: [{ change: "added" }] });
  });

  it("a rerun is compared with its source's test, and a chosen baseline replaces the previous run", async () => {
    const source = await finishedRunWithTest(t, { requirement: `Rerun comparison ${Date.now()}` });
    const rerun1 = (await post(`/v1/test-runs/${source}/rerun`, {})).json().runId;
    await complete(rerun1, "FAIL");
    const rerun2 = (await post(`/v1/test-runs/${source}/rerun`, {})).json().runId;
    await complete(rerun2, "PASS");
    expect((await call(`/v1/test-runs/${rerun2}/comparison`)).json()).toMatchObject({
      baseline: { runId: rerun1 },
      criteria: [{ change: "fixed" }],
    });
    const chosen = await call(`/v1/test-runs/${rerun2}/comparison?baseline=${rerun2}`);
    expect(chosen.statusCode).toBe(400);
    expect((await call(`/v1/test-runs/${rerun2}/comparison?baseline=${source}`)).json().code).toBe("BASELINE_NOT_FINISHED");
  });

  it("refuses a run that has not completed, and a baseline the caller cannot see", async () => {
    const running = await create(`Not finished ${Date.now()}`);
    expect((await call(`/v1/test-runs/${running}/comparison`)).json().code).toBe("RUN_NOT_FINISHED");
    const ann = await signInMember(t);
    const text = `Ownership ${Date.now()}`;
    const adminRun = await create(text);
    await complete(adminRun, "PASS");
    const annRun = await create(text, ann.headers);
    await complete(annRun, "PASS");
    // Ann's previous run of the test is not the admin's: she cannot see it.
    expect((await call(`/v1/test-runs/${annRun}/comparison`, ann.headers)).json().baseline).toBeNull();
    expect((await call(`/v1/test-runs/${annRun}/comparison?baseline=${adminRun}`, ann.headers)).statusCode).toBe(404);
  });

  it("the Markdown report of a completed run compares it with the previous one", async () => {
    const text = `Markdown comparison ${Date.now()}`;
    const first = await create(text);
    await complete(first, "PASS");
    const second = await create(text);
    await complete(second, "FAIL");
    const md = (await call(`/v1/test-runs/${second}/report.md`)).body;
    expect(md).toContain("## Compared with the previous run");
    expect(md).toContain("Passed → Failed");
    expect((await call(`/v1/test-runs/${first}/report.md`)).body).not.toContain("Compared with the previous run");
  });

  it("a suite run marks each finished test regressed, fixed, unchanged or new against its previous run", async () => {
    const source = await finishedRunWithTest(t, { requirement: `Suite comparison ${Date.now()}` });
    const suite = (await post("/v1/suites", { name: `Comparison suite ${Date.now()}` })).json();
    await post(`/v1/suites/${suite.id}/entries`, { sourceRunId: source });
    const first = (await post(`/v1/suites/${suite.id}/runs`, {})).json();
    await complete(first.runIds[0], "PASS");
    expect((await call(`/v1/suite-runs/${first.suiteRunId}`)).json().children[0]).toMatchObject({ change: "new", baselineRunId: null });
    const second = (await post(`/v1/suites/${suite.id}/runs`, {})).json();
    expect((await call(`/v1/suite-runs/${second.suiteRunId}`)).json().children[0]).toMatchObject({ change: null });
    await complete(second.runIds[0], "FAIL");
    expect((await call(`/v1/suite-runs/${second.suiteRunId}`)).json()).toMatchObject({
      changes: { regressed: 1, fixed: 0 },
      children: [{ change: "regressed", baselineRunId: first.runIds[0] }],
    });
  });
});

describe("suite runs for CI (V1.2 F5)", () => {
  it("records the CI job that started it, and gives the settled run as JUnit XML", async () => {
    const source = await finishedRunWithTest(t, { requirement: `JUnit ${Date.now()}` });
    const suite = (await post("/v1/suites", { name: `CI & suite ${Date.now()}` })).json();
    await post(`/v1/suites/${suite.id}/entries`, { sourceRunId: source });
    const ci = { repository: "acme/shop", ref: "refs/heads/main", sha: "abc123", runUrl: "https://github.com/acme/shop/actions/runs/1" };
    expect((await post(`/v1/suites/${suite.id}/runs`, { context: { ...ci, runUrl: "http://insecure.example" } })).statusCode).toBe(400);
    const started = (await post(`/v1/suites/${suite.id}/runs`, { context: ci })).json();
    expect((await call(`/v1/suite-runs/${started.suiteRunId}`)).json()).toMatchObject({ ci, startedWithToken: null });

    expect((await call(`/v1/suite-runs/${started.suiteRunId}/junit.xml`)).json().code).toBe("SUITE_RUN_NOT_FINISHED");
    await complete(started.runIds[0], "FAIL");
    const res = await call(`/v1/suite-runs/${started.suiteRunId}/junit.xml`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/xml; charset=utf-8");
    expect(res.headers["content-disposition"]).toBe(`attachment; filename="junit-${started.suiteRunId}.xml"`);
    expect(res.body).toContain(`<testsuites name="${suite.name.replace("&", "&amp;")}" id="${started.suiteRunId}" tests="1" failures="1"`);
    expect(res.body).toContain('name="AC-1 The cart count is 1"');
    expect(res.body).toContain("<failure");
  });
});
