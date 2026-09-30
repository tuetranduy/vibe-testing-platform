import { RunRepository } from "@platform/db";
import { TEST_TENANT_ID, createTestDatabase, type TestDatabase } from "@platform/db/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_REAPER_CONFIG, REAP_EVERY_MS, startReaper } from "./reaper";

// A dedicated logical DB by default: tests never touch DB 0, where a developer's worker takes jobs.
const REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6379/15";

let tdb: TestDatabase;
let connection: Redis;
beforeAll(async () => {
  tdb = await createTestDatabase();
  connection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
});
afterAll(async () => {
  connection?.disconnect();
  await tdb?.drop();
});

const quiet = { info() {}, warn() {}, error() {} };
const nothingWaiting = {
  isExecuteWaiting: async () => false,
  isAnalyzeAfterSelectionWaiting: async () => false,
  isAnalyzePending: async () => false,
  isRerunPending: async () => false,
};

describe("startReaper", () => {
  it("with no run worker at all (the API's reaper), a run whose worker stopped beating ends ERRORED / WORKER_LOST", async () => {
    const runs = new RunRepository(tdb.db);
    const run = await runs.create({
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
    await runs.transition(run.id, "QUEUED", "ANALYZING_REQUIREMENT");
    await runs.heartbeat(run.id, new Date(Date.now() - 2 * 60_000));

    const reaper = await startReaper(
      { config: { ...DEFAULT_REAPER_CONFIG, confirmationTtlHours: 24 }, db: tdb.db, redis: connection, queue: nothingWaiting, logger: quiet },
      { connection, everyMs: 200 },
    );
    try {
      await vi.waitFor(async () => expect(await runs.getById(run.id)).toMatchObject({ lifecycle: "ERRORED", errorCategory: "WORKER_LOST" }), {
        timeout: 10_000,
        interval: 100,
      });
    } finally {
      await reaper.close();
    }
  }, 20_000);

  it("detects a lost worker within Section 6's two minutes: stale threshold + one reaper interval", () => {
    expect(DEFAULT_REAPER_CONFIG.staleAfterMs + REAP_EVERY_MS).toBeLessThanOrEqual(90_000);
  });
});
