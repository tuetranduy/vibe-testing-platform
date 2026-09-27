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

  it("a click the planner lets through is stopped at the element it resolves to (Delete account): BLOCKED / DESTRUCTIVE_ACTION_NOT_AUTHORIZED; zero delete clicks", async () => {
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

    if (stack.mode === "ci") {
      // The scripted plan blocks nothing ("Click the button in the danger zone", not flagged): the block
      // comes from the executor, which checks the element's name and text before it clicks.
      const events = await store.events(runId);
      expect(events.find((e) => e.type === "plan.created")?.payload).toMatchObject({ blockedCriteria: [] });
      expect(events.some((e) => e.type === "stage.started" && (e.payload as { stage?: string }).stage === "EXPLORING")).toBe(true);
    }
  });
});
