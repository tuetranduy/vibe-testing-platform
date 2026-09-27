import { afterAll, describe, expect, inject, it } from "vitest";
import { api, db, metricValue } from "./support/client";
import { REQUIREMENTS } from "./support/scenarios";

const stack = inject("e2e");
const client = api(stack);
const store = db(stack);
afterAll(() => store.close());

describe("Task 21 step 7 — SSRF", () => {
  it("an open redirect to the metadata address: every criterion BLOCKED / TARGET_BLOCKED_BY_POLICY", async () => {
    const runId = await client.create({
      targetUrl: `${stack.targetUrl}/redirect?to=http://169.254.169.254/`,
      requirement: REQUIREMENTS.cart,
      options: { autoConfirmCriteria: true },
    });
    expect(await client.finished(runId)).toMatchObject({ lifecycle: "COMPLETED", verdict: "BLOCKED" });
    const report = await client.report(runId);
    expect(report.criteria.length).toBeGreaterThan(0);
    for (const c of report.criteria) expect(c).toMatchObject({ status: "BLOCKED", reason: "TARGET_BLOCKED_BY_POLICY" });
    const blocked = (await store.events(runId)).filter((e) => e.type === "step.recorded" && (e.payload as { outcome: string }).outcome === "BLOCKED_BY_POLICY");
    expect(blocked.map((e) => e.payload)).toContainEqual(expect.objectContaining({ kind: "navigate", blockReason: "TARGET_BLOCKED_BY_POLICY" }));
  });

  it("a page that loads from the metadata address: egress.blocked is recorded (and counted), the run still completes", async () => {
    const runId = await client.create({ targetUrl: `${stack.targetUrl}/egress-probe`, requirement: REQUIREMENTS.probe, options: { autoConfirmCriteria: true } });
    expect(await client.finished(runId)).toMatchObject({ lifecycle: "COMPLETED" });
    const egress = (await store.events(runId)).filter((e) => e.type === "egress.blocked");
    expect(egress.map((e) => e.payload)).toContainEqual({ host: "169.254.169.254", reason: "NON_PUBLIC_ADDRESS" });
    const metrics = await (await fetch(stack.workerMetricsUrl)).text();
    expect(metricValue(metrics, "egress_blocked_total", { reason: "NON_PUBLIC_ADDRESS" })).toBeGreaterThanOrEqual(1);
  });

  it("creating a run for http://127.0.0.1 is refused with 422", async () => {
    const res = await client.call("POST", "/v1/test-runs", { targetUrl: "http://127.0.0.1/", requirement: REQUIREMENTS.cart });
    expect(res.status).toBe(422);
    expect(res.json.code).toBe("TARGET_NOT_ALLOWED");
  });
});
