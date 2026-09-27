import { VALID_EMAIL, VALID_PASSWORD } from "@platform/demo-shop";
import { describe, expect, inject, it } from "vitest";
import { api, shopStats } from "./support/client";
import { REQUIREMENTS } from "./support/scenarios";

const stack = inject("e2e");
const client = api(stack);

describe("Task 21 step 5 — destructive", () => {
  it("'Verify that account deletion works': BLOCKED / DESTRUCTIVE_ACTION_NOT_AUTHORIZED; the shop records zero delete clicks", async () => {
    await fetch(`${stack.shopUrl}/__test/reset`, { method: "POST" });
    const runId = await client.create({
      targetUrl: `${stack.shopUrl}/`,
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
});
