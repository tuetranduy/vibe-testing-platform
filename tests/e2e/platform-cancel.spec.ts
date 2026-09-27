import { existsSync } from "node:fs";
import path from "node:path";
import { VALID_PASSWORD } from "@platform/demo-shop";
import { afterAll, describe, expect, inject, it } from "vitest";
import { api, db, processesMentioning } from "./support/client";
import { REQUIREMENTS } from "./support/scenarios";

const stack = inject("e2e");
const client = api(stack);
const store = db(stack);
afterAll(() => store.close());

describe("Task 21 step 4 — cancel", () => {
  it("?slow=5000, cancelled while EXPLORING: CANCELLED within 10 s; browser and runner gone; secrets purged", async () => {
    const runId = await client.create({
      targetUrl: `${stack.shopUrl}/?slow=5000`,
      requirement: REQUIREMENTS.cart,
      secrets: { password: VALID_PASSWORD },
      options: { autoConfirmCriteria: true },
    });
    await client.waitFor(runId, (r) => r.lifecycle === "EXPLORING", 60_000);
    // The sandboxed Chromium is up (its profile dir carries the run id).
    await expect.poll(() => processesMentioning(runId).length, { timeout: 10_000 }).toBeGreaterThan(0);

    const cancelledAt = Date.now();
    expect((await client.cancel(runId)).status).toBe(202);
    const done = await client.waitFor(runId, (r) => r.lifecycle === "CANCELLED", 10_000);
    expect(Date.now() - cancelledAt).toBeLessThan(10_000);
    expect(done.cancelReason).toBe("USER_REQUESTED");

    await expect.poll(() => processesMentioning(runId), { timeout: 5_000 }).toEqual([]);
    expect(existsSync(path.join(stack.runnerDir, runId))).toBe(false);
    expect(await store.secretsActive(runId)).toEqual([]);
    expect((await store.events(runId)).map((e) => e.type)).toContain("run.cancelled");
  });
});
