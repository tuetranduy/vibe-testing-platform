import { RunRepository } from "@platform/db";
import { CancelledError } from "@platform/testing-engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRunContext } from "./run-context";
import { createFakeStages, createHarness, requestCancel, seedRun, type WorkerHarness } from "./test-support";
let h: WorkerHarness;
beforeAll(async () => { h = await createHarness(); });
afterAll(async () => h?.close());
describe("assistance pauses the worker clocks (2026-11-21)", () => {
  it("reserves the reaper deadline, reclaims unused wait, and retains cancellation", async () => {
    const run = await seedRun(h, { lifecycle: "PLANNING" });
    const deadlineAt = new Date(Date.now() + 60000);
    const original = deadlineAt.getTime();
    const handle = await createRunContext(h.deps(createFakeStages()), run, { deadlineAt, totalBudgetMs: 60000 });
    try {
      const budget = handle.ctx.budgetSignal(100);
      const resume = await handle.ctx.pauseBudgets!(600000);
      expect((await new RunRepository(h.tdb.db).getById(run.id)).deadlineAt!.getTime()).toBe(original + 600000);
      await new Promise((r) => setTimeout(r, 150));
      expect(budget.aborted).toBe(false);
      await resume();
      const persisted = (await new RunRepository(h.tdb.db).getById(run.id)).deadlineAt!.getTime();
      expect(persisted).toBeGreaterThanOrEqual(original + 150);
      expect(persisted).toBeLessThan(original + 5000);
      const resumeAgain = await handle.ctx.pauseBudgets!(600000);
      await requestCancel(h, run.id);
      await new Promise<void>((resolve) => {
        if (handle.ctx.signal.aborted) resolve();
        else handle.ctx.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      expect(handle.ctx.signal.reason).toBeInstanceOf(CancelledError);
      expect(budget.aborted).toBe(true);
      await resumeAgain();
    } finally { await handle.dispose(); }
  });
});
