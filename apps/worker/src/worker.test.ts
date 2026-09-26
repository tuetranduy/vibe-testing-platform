import { RunRepository } from "@platform/db";
import { createRunQueue } from "@platform/event-bus";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { REDIS_URL, createFakeStages, createHarness, eventsOf, seedRun, type WorkerHarness } from "./test-support";
import { startWorkers } from "./worker";

let h: WorkerHarness;
let connection: Redis;
beforeAll(async () => {
  h = await createHarness();
  // REDIS_URL is the tests' own logical DB (default /15), so a locally running worker never picks
  // these jobs up. Clear leftover jobs from an earlier run — but never in DB 0, which may be a
  // developer's live queue if TEST_REDIS_URL points there.
  connection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  if ((connection.options.db ?? 0) !== 0) await connection.flushdb();
});
afterAll(async () => {
  connection?.disconnect();
  await h?.close();
});

describe("BullMQ wiring", () => {
  it("runs analyze-run then execute-run end to end through real queues", async () => {
    const queue = createRunQueue(connection);
    const deps = h.deps(createFakeStages(), { queue });
    const workers = await startWorkers(deps, { connection, concurrency: 2, reapEveryMs: 60_000 });
    try {
      const run = await seedRun(h, { options: { autoConfirmCriteria: true } });
      await queue.enqueueAnalyze(run.id);
      // Generous: under a loaded machine (the full suite runs real Chromium) the queues can be slow.
      // The orchestrator transitions to COMPLETED, then publishes run.completed: wait for both.
      await vi.waitFor(
        async () => {
          expect((await new RunRepository(h.tdb.db).getById(run.id)).lifecycle).toBe("COMPLETED");
          expect((await eventsOf(h, run.id)).at(-1)!.type).toBe("run.completed");
        },
        { timeout: 30_000, interval: 100 },
      );
      // Duplicate enqueue is deduplicated by jobId.
      await queue.enqueueExecute(run.id);
      expect(await queue.isExecuteWaiting(run.id)).toBe(false);
    } finally {
      await workers.close();
      await queue.close();
    }
  }, 45_000);
});
