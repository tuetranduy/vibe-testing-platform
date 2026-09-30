import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SUITE_SCHEDULES_QUEUE, createScheduleSync, type ScheduleSync } from "./queues";

const REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6379/15";
let connection: Redis;
let sync: ScheduleSync;
beforeAll(async () => {
  connection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  sync = createScheduleSync(connection);
  for (const id of await sync.ids()) await sync.remove(id);
});
afterAll(async () => {
  await sync?.close();
  connection?.disconnect();
});

describe("createScheduleSync (V1.2 F3)", () => {
  it("creates, replaces and removes one job scheduler per schedule, with its cron and time zone", async () => {
    await sync.upsert({ id: "sch_a", cron: "0 9 * * *", timezone: "Europe/Zurich" });
    await sync.upsert({ id: "sch_b", cron: "30 18 * * 1-5", timezone: "UTC" });
    await sync.upsert({ id: "sch_a", cron: "15 9 * * *", timezone: "Europe/Zurich" });
    expect((await sync.ids()).sort()).toEqual(["sch_a", "sch_b"]);

    const queue = new Queue(SUITE_SCHEDULES_QUEUE, { connection });
    try {
      const a = (await queue.getJobSchedulers()).find((s) => s.key === "sch_a")!;
      expect(a).toMatchObject({ pattern: "15 9 * * *", tz: "Europe/Zurich", template: { data: { scheduleId: "sch_a" } } });
    } finally {
      await queue.close();
    }

    await sync.remove("sch_a");
    await sync.remove("sch_missing");
    expect(await sync.ids()).toEqual(["sch_b"]);
    await sync.remove("sch_b");
  });
});
