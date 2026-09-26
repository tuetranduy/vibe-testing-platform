import type { TestEvent } from "@platform/contracts";
import { EventRepository, RunRepository } from "@platform/db";
import { TEST_TENANT_ID, createTestDatabase, type TestDatabase } from "@platform/db/testing";
import { createRunRedactor } from "@platform/security";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runEventsChannel } from "./channels";
import { createRunEventPublisher } from "./publisher";
import { RunEventHub } from "./subscriber";

// A dedicated logical DB by default: tests never touch DB 0, where a developer's worker takes jobs.
const REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6379/15";

let tdb: TestDatabase;
let redis: Redis;
let sub: Redis;
beforeAll(async () => {
  tdb = await createTestDatabase();
  redis = new Redis(REDIS_URL);
  sub = new Redis(REDIS_URL);
});
afterAll(async () => {
  redis?.disconnect();
  sub?.disconnect();
  await tdb?.drop();
});

async function newRun() {
  return new RunRepository(tdb.db).create({
    tenantId: TEST_TENANT_ID,
    targetUrl: "https://x.com",
    request: {
      targetUrl: "https://x.com",
      requirement: "Requirement text here",
      environment: "staging",
      browser: "chromium",
      testData: {},
      secretNames: [],
      options: {
        maxExplorationSteps: 40,
        maxRunSeconds: 300,
        generatePlaywright: true,
        rerunGeneratedTest: true,
        autoConfirmCriteria: false,
        allowDestructiveActions: false,
        additionalAllowedHosts: [],
      },
    },
  });
}

describe("createRunEventPublisher", () => {
  it("persists with sequences 1, 2 and publishes both on run-events:<runId>", async () => {
    const run = await newRun();
    const received: TestEvent[] = [];
    const hub = new RunEventHub(sub);
    const unsub = await hub.subscribe(run.id, (e) => received.push(e));
    const pub = createRunEventPublisher({ events: new EventRepository(tdb.db), redis, redact: (v) => v });
    const a = await pub.publish({ runId: run.id, stage: "QUEUED", type: "run.created", message: "Run created", payload: { targetHost: "x.com" } });
    const b = await pub.publish({ runId: run.id, stage: "ANALYZING_REQUIREMENT", type: "stage.started", message: "Analyzing", payload: { stage: "ANALYZING_REQUIREMENT" } });
    expect([a.sequence, b.sequence]).toEqual([1, 2]);
    await vi.waitFor(() => expect(received.map((e) => e.sequence)).toEqual([1, 2]));
    expect((await new EventRepository(tdb.db).listAfter(run.id, 0)).map((e) => e.type)).toEqual(["run.created", "stage.started"]);
    await unsub();
  });

  it("stores and publishes payloads redacted by value", async () => {
    const run = await newRun();
    const published: string[] = [];
    const fakeRedis = { publish: async (_c: string, m: string) => { published.push(m); return 1; } };
    const pub = createRunEventPublisher({
      events: new EventRepository(tdb.db),
      redis: fakeRedis,
      redact: createRunRedactor(["hunter2-long"]),
    });
    const e = await pub.publish({
      runId: run.id,
      stage: "EXPLORING",
      type: "run.errored",
      message: "Login failed for hunter2-long",
      payload: { category: "INTERNAL", message: "typed hunter2-long into field" },
    });
    expect(e.message).toBe("Login failed for [REDACTED]");
    expect(e.payload).toEqual({ category: "INTERNAL", message: "typed [REDACTED] into field" });
    const [stored] = await new EventRepository(tdb.db).listAfter(run.id, 0);
    expect(JSON.stringify(stored)).not.toContain("hunter2-long");
    expect(published.join("")).not.toContain("hunter2-long");
  });

  it("throws before persisting when the payload does not match the type", async () => {
    const run = await newRun();
    const pub = createRunEventPublisher({ events: new EventRepository(tdb.db), redis, redact: (v) => v });
    await expect(
      pub.publish({ runId: run.id, stage: "VERIFYING", type: "criterion.evaluated", message: "x", payload: {} } as never),
    ).rejects.toThrow();
    expect(await new EventRepository(tdb.db).listAfter(run.id, 0)).toHaveLength(0);
  });

  it("keeps the DB event and succeeds when Redis publish fails", async () => {
    const run = await newRun();
    const warn = vi.fn();
    const pub = createRunEventPublisher({
      events: new EventRepository(tdb.db),
      redis: { publish: async () => { throw new Error("redis down"); } },
      redact: (v) => v,
      logger: { warn },
    });
    const e = await pub.publish({ runId: run.id, stage: "QUEUED", type: "run.created", message: "Run created", payload: { targetHost: "x.com" } });
    expect(e.sequence).toBe(1);
    expect(warn).toHaveBeenCalledOnce();
    expect(await new EventRepository(tdb.db).listAfter(run.id, 0)).toHaveLength(1);
  });

  it("uses the documented channel name", () => {
    expect(runEventsChannel("run_1")).toBe("run-events:run_1");
  });
});
