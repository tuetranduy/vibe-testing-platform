import type { RunLifecycle, StoredTestRunRequest, TestEvent } from "@platform/contracts";
import { EventRepository, RequirementRepository, RunRepository, SecretRepository, type TestRun } from "@platform/db";
import { TEST_TENANT_ID, createTestDatabase, type TestDatabase } from "@platform/db/testing";
import { runCancelChannel, type RunQueue } from "@platform/event-bus";
import { encryptSecret } from "@platform/security";
import { createFakeStages, type EngineStages, type FakeEngineOptions } from "@platform/testing-engine";
import { Redis } from "ioredis";
import { CancelWatcher } from "./cancel-watcher";
import { silentLogger, type WorkerDeps } from "./deps";

export const SECRETS_KEY = Buffer.alloc(32, 5);
export const REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6379";

export class FakeQueue implements RunQueue {
  analyze: string[] = [];
  execute: string[] = [];
  waiting = new Set<string>();
  async enqueueAnalyze(runId: string) {
    this.analyze.push(runId);
  }
  async enqueueExecute(runId: string) {
    this.execute.push(runId);
  }
  async isExecuteWaiting(runId: string) {
    return this.waiting.has(runId);
  }
  async close() {}
}

export interface WorkerHarness {
  tdb: TestDatabase;
  redis: Redis;
  queue: FakeQueue;
  deps(stages: EngineStages, overrides?: Partial<WorkerDeps>): WorkerDeps;
  close(): Promise<void>;
}

export async function createHarness(): Promise<WorkerHarness> {
  const tdb = await createTestDatabase();
  const redis = new Redis(REDIS_URL);
  const watcher = new CancelWatcher(new Redis(REDIS_URL));
  const queue = new FakeQueue();
  return {
    tdb,
    redis,
    queue,
    deps: (stages, overrides = {}) => ({
      config: {
        secretsKey: SECRETS_KEY,
        analysisTimeoutSeconds: 120,
        heartbeatMs: 20,
        staleAfterMs: 60_000,
        confirmationTtlHours: 24,
        // maxRunSeconds 60 → 600 ms total; exploration budget 360 ms.
        timeScale: 0.01,
      },
      db: tdb.db,
      redis,
      cancelWatcher: watcher,
      queue,
      stages,
      logger: silentLogger,
      ...overrides,
    }),
    async close() {
      watcher.close();
      redis.disconnect();
      await tdb.drop();
    },
  };
}

export function request(overrides: Partial<StoredTestRunRequest["options"]> = {}, secretNames: string[] = []): StoredTestRunRequest {
  return {
    targetUrl: "https://shop.example.com",
    requirement: "A user can add a product to the cart. The cart count should increase.",
    environment: "staging",
    browser: "chromium",
    testData: {},
    secretNames,
    options: {
      maxExplorationSteps: 40,
      maxRunSeconds: 60,
      generatePlaywright: true,
      rerunGeneratedTest: true,
      autoConfirmCriteria: false,
      allowDestructiveActions: false,
      additionalAllowedHosts: [],
      ...overrides,
    },
  };
}

/** Creates a run and walks it to `lifecycle` (PLANNING includes a confirmed requirement). */
export async function seedRun(
  h: WorkerHarness,
  opts: { lifecycle?: RunLifecycle; options?: Partial<StoredTestRunRequest["options"]>; secrets?: Record<string, string> } = {},
): Promise<TestRun> {
  const runs = new RunRepository(h.tdb.db);
  const secrets = opts.secrets ?? {};
  const run = await runs.create({
    tenantId: TEST_TENANT_ID,
    targetUrl: "https://shop.example.com",
    request: request(opts.options, Object.keys(secrets)),
  });
  await new SecretRepository(h.tdb.db).insertMany(
    run.id,
    Object.entries(secrets).map(([name, v]) => ({ name, ...encryptSecret(v, { runId: run.id, name }, SECRETS_KEY) })),
  );
  const target = opts.lifecycle ?? "QUEUED";
  if (target === "QUEUED") return run;
  await runs.transition(run.id, "QUEUED", "ANALYZING_REQUIREMENT", { heartbeatAt: new Date() });
  if (target === "ANALYZING_REQUIREMENT") return runs.getById(run.id);
  const stages = createFakeStages();
  const draft = await stages.analyze({ request: run.request } as never);
  const reqs = new RequirementRepository(h.tdb.db);
  await reqs.createRevision(run.id, draft);
  await runs.transition(run.id, "ANALYZING_REQUIREMENT", "AWAITING_CONFIRMATION");
  if (target === "AWAITING_CONFIRMATION") return runs.getById(run.id);
  await reqs.confirm(run.id, 1);
  await runs.transition(run.id, "AWAITING_CONFIRMATION", "PLANNING", { heartbeatAt: new Date() });
  return runs.getById(run.id);
}

export async function eventsOf(h: WorkerHarness, runId: string): Promise<TestEvent[]> {
  return new EventRepository(h.tdb.db).listAfter(runId, 0, 1000);
}

export async function requestCancel(h: WorkerHarness, runId: string, viaRedis = true): Promise<void> {
  await new RunRepository(h.tdb.db).requestCancel(runId, "USER_REQUESTED");
  if (viaRedis) await h.redis.publish(runCancelChannel(runId), "cancel");
}

export { createFakeStages, type FakeEngineOptions };
