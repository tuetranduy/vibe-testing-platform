import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RUNS_QUEUE, createRunQueue, suiteChildPriority, type RunJobData, type RunQueue } from "./queues";

const REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6379/15";
let connection: Redis;
let runs: RunQueue;
beforeAll(async () => {
  connection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  const queue = new Queue(RUNS_QUEUE, { connection });
  await queue.obliterate({ force: true });
  await queue.close();
  runs = createRunQueue(connection);
});
afterAll(async () => {
  await runs?.close();
  connection?.disconnect();
});

describe("createRunQueue: suite children (KI-038)", () => {
  it("takes single runs first, then the suites' children turn by turn", async () => {
    for (const n of [0, 1, 2]) await runs.enqueueRerun(`suite_a_${n}`, { suitePosition: n });
    for (const n of [0, 1]) await runs.enqueueRerun(`suite_b_${n}`, { suitePosition: n });
    await runs.enqueueRerun("single");
    await runs.enqueueExecute("explore");

    const order: string[] = [];
    const worker = new Worker<RunJobData>(
      RUNS_QUEUE,
      async (job) => {
        order.push(job.data.runId);
      },
      { connection: connection.duplicate(), concurrency: 1 },
    );
    try {
      await expect.poll(() => order.length, { timeout: 10_000 }).toBe(7);
    } finally {
      await worker.close();
    }
    expect(order).toEqual(["single", "explore", "suite_a_0", "suite_b_0", "suite_a_1", "suite_b_1", "suite_a_2"]);
  });

  it("keeps the priority inside BullMQ's range", () => {
    expect(suiteChildPriority(0)).toBe(1);
    expect(suiteChildPriority(-3)).toBe(1);
    expect(suiteChildPriority(10_000_000)).toBe(2_097_152);
  });
});
