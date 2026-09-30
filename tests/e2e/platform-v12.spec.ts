import { VALID_EMAIL, VALID_PASSWORD } from "@platform/demo-shop";
import { afterAll, describe, expect, inject, it } from "vitest";
import { api, db } from "./support/client";
import { REQUIREMENTS } from "./support/scenarios";

const stack = inject("e2e");
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
