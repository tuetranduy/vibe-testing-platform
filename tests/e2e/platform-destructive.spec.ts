import { VALID_EMAIL, VALID_PASSWORD } from "@platform/demo-shop";
import { afterAll, describe, expect, inject, it } from "vitest";
import { api, db, shopStats } from "./support/client";
import { REQUIREMENTS } from "./support/scenarios";

const stack = inject("e2e");
const client = api(stack);
const store = db(stack);
afterAll(() => store.close());

describe("Task 21 step 5 — destructive", () => {
  it("'Verify that account deletion works': BLOCKED / DESTRUCTIVE_ACTION_NOT_AUTHORIZED; the shop records zero delete clicks", async () => {
    await fetch(`${stack.shopUrl}/__test/reset`, { method: "POST" });
    const runId = await client.create({
      targetUrl: `${stack.targetUrl}/`,
      requirement: REQUIREMENTS.deletion,
      testData: { email: VALID_EMAIL },
      secrets: { password: VALID_PASSWORD },
      options: { autoConfirmCriteria: true },
    });
    expect(await client.finished(runId)).toMatchObject({ lifecycle: "COMPLETED", verdict: "BLOCKED" });
    const report = await client.report(runId);
    expect(report.criteria.length).toBeGreaterThan(0);
    for (const c of report.criteria) expect(c).toMatchObject({ status: "BLOCKED", reason: "DESTRUCTIVE_ACTION_NOT_AUTHORIZED" });
    expect(await shopStats(stack)).toEqual({ deleteClicks: 0 });
  });

  // CI mode only: the scripted plan is what lets the click through to the executor. A real model plans
  // it itself (and the planner may block it first); the injection spec covers the element check there.
  it.skipIf(stack.mode === "live")("a click the planner lets through is stopped at the element it resolves to (Delete account): BLOCKED / DESTRUCTIVE_ACTION_NOT_AUTHORIZED; zero delete clicks", async () => {
    await fetch(`${stack.shopUrl}/__test/reset`, { method: "POST" });
    const runId = await client.create({
      targetUrl: `${stack.targetUrl}/`,
      requirement: REQUIREMENTS.dangerZone,
      testData: { email: VALID_EMAIL },
      secrets: { password: VALID_PASSWORD },
      options: { autoConfirmCriteria: true },
    });
    expect(await client.finished(runId)).toMatchObject({ lifecycle: "COMPLETED", verdict: "BLOCKED" });
    const report = await client.report(runId);
    expect(report.criteria.length).toBeGreaterThan(0);
    for (const c of report.criteria) expect(c).toMatchObject({ status: "BLOCKED", reason: "DESTRUCTIVE_ACTION_NOT_AUTHORIZED" });
    expect(await shopStats(stack)).toEqual({ deleteClicks: 0 });

    // The plan blocks nothing ("Click the button in the danger zone", not flagged): the block comes from
    // the executor, which checks the element's name and text before it clicks.
    const events = await store.events(runId);
    expect(events.find((e) => e.type === "plan.created")?.payload).toMatchObject({ blockedCriteria: [] });
    expect(events.some((e) => e.type === "stage.started" && (e.payload as { stage?: string }).stage === "EXPLORING")).toBe(true);
  });

  it("production + destructive actions without the host typed as confirmation → 400 on options.confirmProductionHost", async () => {
    const res = await client.call("POST", "/v1/test-runs", {
      targetUrl: `${stack.targetUrl}/`,
      requirement: REQUIREMENTS.deletion,
      environment: "production",
      options: { autoConfirmCriteria: true, allowDestructiveActions: true },
    });
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ code: "VALIDATION_FAILED", issues: [{ path: ["options", "confirmProductionHost"] }] });
  });

  // CI mode only: the scripted plan decides the steps.
  it.skipIf(stack.mode === "live")("production with the host confirmed: the deletion runs once (the rerun is off by default) and nothing is blocked", async () => {
    await fetch(`${stack.shopUrl}/__test/reset`, { method: "POST" });
    const runId = await client.create({
      targetUrl: `${stack.targetUrl}/`,
      requirement: REQUIREMENTS.deletion,
      environment: "production",
      testData: { email: VALID_EMAIL },
      secrets: { password: VALID_PASSWORD },
      options: { autoConfirmCriteria: true, allowDestructiveActions: true, confirmProductionHost: new URL(stack.targetUrl).host },
    });
    expect(await client.finished(runId)).toMatchObject({ lifecycle: "COMPLETED", environment: "production", allowDestructiveActions: true });
    const report = await client.report(runId);
    expect(report.criteria.length).toBeGreaterThan(0);
    for (const c of report.criteria) expect(c.reason).not.toBe("DESTRUCTIVE_ACTION_NOT_AUTHORIZED");
    expect((await store.events(runId)).some((e) => e.type === "playwright.completed")).toBe(false);
    expect(await shopStats(stack)).toEqual({ deleteClicks: 1 });
  });

  it.skipIf(stack.mode === "live")("production with the host confirmed still stops a neutral step that resolves to Delete account: BLOCKED / DESTRUCTIVE_ACTION_NOT_AUTHORIZED; zero delete clicks", async () => {
    await fetch(`${stack.shopUrl}/__test/reset`, { method: "POST" });
    const runId = await client.create({
      targetUrl: `${stack.targetUrl}/`,
      requirement: REQUIREMENTS.dangerZone,
      environment: "production",
      testData: { email: VALID_EMAIL },
      secrets: { password: VALID_PASSWORD },
      options: { autoConfirmCriteria: true, allowDestructiveActions: true, confirmProductionHost: new URL(stack.targetUrl).host },
    });
    expect(await client.finished(runId)).toMatchObject({ lifecycle: "COMPLETED", verdict: "BLOCKED" });
    const report = await client.report(runId);
    expect(report.criteria.length).toBeGreaterThan(0);
    for (const c of report.criteria) expect(c).toMatchObject({ status: "BLOCKED", reason: "DESTRUCTIVE_ACTION_NOT_AUTHORIZED" });
    expect(await shopStats(stack)).toEqual({ deleteClicks: 0 });
  });
});
