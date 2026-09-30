import { VALID_EMAIL, VALID_PASSWORD } from "@platform/demo-shop";
import { afterAll, describe, expect, inject, it } from "vitest";
import { api, db } from "./support/client";
import { REQUIREMENTS } from "./support/scenarios";

const stack = inject("e2e");

async function signIn(email: string, password: string) {
  const res = await service.call("POST", "/v1/auth/login", { email, password });
  if (res.status !== 200) throw new Error(`login → ${res.status} ${res.text}`);
  return api(stack, res.json.token as string);
}
const service = api(stack);
const store = db(stack);
afterAll(() => store.close());

/** Polls a suite run until it has settled. */
async function suiteRunSettled(suiteRunId: string, timeoutMs = 150_000) {
  const deadline = Date.now() + timeoutMs;
  let last: any;
  while (Date.now() < deadline) {
    last = (await service.call("GET", `/v1/suite-runs/${suiteRunId}`)).json;
    if (last?.status === "COMPLETED") return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for suite run ${suiteRunId}; last ${JSON.stringify(last)}`);
}

/** A finished, passing run with a saved Playwright test. */
async function passingRun(body: Record<string, unknown>) {
  const runId = await service.create({ targetUrl: `${stack.targetUrl}/`, options: { autoConfirmCriteria: true }, ...body });
  expect(await service.finished(runId)).toMatchObject({ lifecycle: "COMPLETED", verdict: "PASSED" });
  return runId;
}

describe("V1.2 F1 — suites", () => {
  it("runs two saved tests together, each as its own rerun with no model call, and settles the suite run PASSED", async () => {
    const cart = await passingRun({ requirement: REQUIREMENTS.cart });
    const account = await passingRun({ requirement: REQUIREMENTS.account, testData: { email: VALID_EMAIL }, secrets: { password: VALID_PASSWORD } });
    const profile = await service.call("POST", "/v1/credential-profiles", { name: "Suite shop account", secrets: { password: VALID_PASSWORD } });
    const suite = await service.call("POST", "/v1/suites", { name: "Shop smoke", credentialProfileId: profile.json.id });
    expect(suite.status).toBe(201);
    for (const sourceRunId of [cart, account]) {
      expect((await service.call("POST", `/v1/suites/${suite.json.id}/entries`, { sourceRunId })).status).toBe(201);
    }

    const started = await service.call("POST", `/v1/suites/${suite.json.id}/runs`, {});
    expect(started.status).toBe(202);
    const settled = await suiteRunSettled(started.json.suiteRunId);
    expect(settled).toMatchObject({ status: "COMPLETED", verdict: "PASSED", counts: { total: 2, passed: 2 } });
    expect(settled.children.map((c: { sourceRunId: string }) => c.sourceRunId)).toEqual([cart, account]);
    for (const runId of started.json.runIds as string[]) {
      expect(await service.get(runId)).toMatchObject({ kind: "rerun", suiteRunId: started.json.suiteRunId, verdict: "PASSED" });
      expect(await store.llmCalls(runId)).toEqual([]);
      expect(await store.secretsActive(runId)).toEqual([]);
    }
  });
});

describe("V1.2 F2 — compare with the previous run", () => {
  it("a rerun is compared with its test's previous run; a broken cart regresses against a chosen passing run", async () => {
    const passing = await passingRun({ requirement: REQUIREMENTS.cart });
    const rerun = await service.call("POST", `/v1/test-runs/${passing}/rerun`, {});
    expect(await service.finished(rerun.json.runId)).toMatchObject({ verdict: "PASSED" });
    const same = await service.call("GET", `/v1/test-runs/${rerun.json.runId}/comparison`);
    expect(same.json).toMatchObject({ baseline: { runId: passing }, verdict: { before: "PASSED", after: "PASSED" }, counts: { regressed: 0 } });

    const broken = await service.create({
      targetUrl: `${stack.targetUrl}/?bug=empty_cart`,
      requirement: REQUIREMENTS.cart,
      options: { autoConfirmCriteria: true },
    });
    expect(await service.finished(broken)).toMatchObject({ verdict: "FAILED" });
    const compared = await service.call("GET", `/v1/test-runs/${broken}/comparison?baseline=${passing}`);
    expect(compared.json).toMatchObject({ chosenBaseline: true, verdict: { before: "PASSED", after: "FAILED" } });
    expect(compared.json.counts.regressed).toBeGreaterThan(0);
    const md = await fetch(`${stack.apiUrl}/v1/test-runs/${rerun.json.runId}/report.md`, { headers: { authorization: `Bearer ${stack.apiToken}` } });
    expect(await md.text()).toContain("## Compared with the previous run");
  });
});

describe("V1.2 F3 — scheduled suite runs", () => {
  it("a schedule fires on its own and runs the suite as its creator", async () => {
    const admin = await signIn(stack.admin.email, stack.admin.password);
    const cart = await passingRun({ requirement: REQUIREMENTS.cart });
    const suite = (await admin.call("POST", "/v1/suites", { name: "Every minute" })).json;
    expect((await admin.call("POST", `/v1/suites/${suite.id}/entries`, { sourceRunId: cart })).status).toBe(201);
    const schedule = await admin.call("POST", `/v1/suites/${suite.id}/schedules`, { cron: "* * * * *", timezone: "UTC" });
    expect(schedule.status).toBe(201);

    const deadline = Date.now() + 90_000;
    let fired: { lastOutcome: string | null; lastSuiteRunId: string | null } | undefined;
    while (Date.now() < deadline) {
      fired = (await admin.call("GET", `/v1/suites/${suite.id}/schedules`)).json.items[0];
      if (fired?.lastOutcome) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    // Stop it before asserting, so a failed assertion leaves nothing firing.
    await admin.call("DELETE", `/v1/suite-schedules/${schedule.json.id}`);
    expect(fired).toMatchObject({ lastOutcome: "started" });
    const settled = await suiteRunSettled(fired!.lastSuiteRunId!);
    expect(settled).toMatchObject({ trigger: "schedule", verdict: "PASSED", owner: { name: expect.any(String) } });
  }, 180_000);
});
