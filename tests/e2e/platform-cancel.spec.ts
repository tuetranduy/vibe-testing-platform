import { VALID_PASSWORD } from "@platform/demo-shop";
import { afterAll, describe, expect, inject, it } from "vitest";
import { api, db, processesMentioning, runnerWorkspaceExists } from "./support/client";
import { REQUIREMENTS } from "./support/scenarios";

const stack = inject("e2e");
const client = api(stack);
const store = db(stack);
afterAll(() => store.close());

describe("Task 21 step 4 — cancel", () => {
  it("?slow=5000, cancelled while EXPLORING: CANCELLED within 10 s; browser gone; secrets purged", async () => {
    const runId = await client.create({
      targetUrl: `${stack.targetUrl}/?slow=5000`,
      requirement: REQUIREMENTS.cart,
      secrets: { password: VALID_PASSWORD },
      options: { autoConfirmCriteria: true },
    });
    await client.waitFor(runId, (r) => r.lifecycle === "EXPLORING", 60_000);
    // The sandboxed Chromium is up (its profile dir carries the run id).
    await expect.poll(() => processesMentioning(stack, runId).length, { timeout: 10_000 }).toBeGreaterThan(0);

    const cancelledAt = Date.now();
    expect((await client.cancel(runId)).status).toBe(202);
    const done = await client.waitFor(runId, (r) => r.lifecycle === "CANCELLED", 10_000);
    expect(Date.now() - cancelledAt).toBeLessThan(10_000);
    expect(done.cancelReason).toBe("USER_REQUESTED");

    await expect.poll(() => processesMentioning(stack, runId), { timeout: 5_000 }).toEqual([]);
    // The worker purges secrets after it releases the run's resources, which follows the CANCELLED transition.
    await expect.poll(() => store.secretsActive(runId), { timeout: 5_000 }).toEqual([]);
    expect((await store.events(runId)).map((e) => e.type)).toContain("run.cancelled");
  });

  it("?slow=1500, cancelled while RUNNING_PLAYWRIGHT: CANCELLED within 10 s; the runner's processes and its workspace are gone; secrets purged", async () => {
    // Every page takes 1.5 s, so the rerun of the cart flow runs for several seconds.
    const runId = await client.create({
      targetUrl: `${stack.targetUrl}/?slow=1500`,
      requirement: REQUIREMENTS.cart,
      secrets: { password: VALID_PASSWORD },
      options: { autoConfirmCriteria: true },
    });
    await client.waitFor(runId, (r) => r.lifecycle === "RUNNING_PLAYWRIGHT", 120_000);
    // The runner is up: its workspace exists, and its processes (the Playwright CLI in the workspace,
    // Chromium with a profile under the workspace's tmp/) carry the run id.
    await expect.poll(() => runnerWorkspaceExists(stack, runId) && processesMentioning(stack, runId).length > 0, { timeout: 15_000 }).toBe(true);

    const cancelledAt = Date.now();
    expect((await client.cancel(runId)).status).toBe(202);
    const done = await client.waitFor(runId, (r) => r.lifecycle === "CANCELLED", 10_000);
    expect(Date.now() - cancelledAt).toBeLessThan(10_000);
    expect(done.cancelReason).toBe("USER_REQUESTED");

    await expect.poll(() => processesMentioning(stack, runId), { timeout: 5_000 }).toEqual([]);
    await expect.poll(() => runnerWorkspaceExists(stack, runId), { timeout: 5_000 }).toBe(false);
    await expect.poll(() => store.secretsActive(runId), { timeout: 5_000 }).toEqual([]);
    const types = (await store.events(runId)).map((e) => e.type);
    expect(types).toContain("run.cancelled");
    expect(types).not.toContain("playwright.completed");
  });
});
