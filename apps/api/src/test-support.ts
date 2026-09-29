import { TEST_TENANT_ID, createTestDatabase, type TestDatabase } from "@platform/db/testing";
import { RunEventHub, type RunQueue } from "@platform/event-bus";
import type { Resolver } from "@platform/security";
import type { ArtifactStorage } from "@platform/storage";
import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { buildApp } from "./app";
import type { ApiDeps, ApiLlmConfig } from "./deps";
import { createCancelSignal } from "./services/cancel-signal";

export const API_TOKEN = "test-api-token-0123456789";
export const SECRETS_KEY = Buffer.alloc(32, 9);
// A dedicated logical DB by default: tests never touch DB 0, where a developer's worker takes jobs.
export const REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6379/15";
export const auth = { authorization: `Bearer ${API_TOKEN}` };

export const FAKE_LLM: ApiLlmConfig = {
  envChoice: { provider: "fake", model: "fake", reasoning: "default" },
  envKeys: { anthropic: false, gemini: false },
  fakeAllowed: true,
};

export class FakeQueue implements RunQueue {
  analyze: string[] = [];
  execute: string[] = [];
  fail = false;
  async enqueueAnalyze(runId: string) {
    if (this.fail) throw new Error("queue down");
    this.analyze.push(runId);
  }
  async enqueueExecute(runId: string) {
    if (this.fail) throw new Error("queue down");
    this.execute.push(runId);
  }
  async isExecuteWaiting() {
    return false;
  }
  async isAnalyzePending() {
    return false;
  }
  afterSelection: string[] = [];
  async enqueueAnalyzeAfterSelection(runId: string) {
    if (this.fail) throw new Error("queue down");
    this.afterSelection.push(runId);
  }
  async isAnalyzeAfterSelectionWaiting(_runId: string) {
    return false;
  }
  depthValue = 0;
  depthFails = false;
  /** Like the real queue while Redis is down: ioredis holds the command until it reconnects. */
  depthHangs = false;
  async depth() {
    if (this.depthFails) throw new Error("redis down");
    if (this.depthHangs) return new Promise<number>(() => {});
    return this.depthValue;
  }
  async close() {}
}

export class FakeStorage implements ArtifactStorage {
  async put(): Promise<never> {
    throw new Error("not used");
  }
  async getSignedReadUrl(objectKey: string, ttl: number) {
    return `https://storage.test/${objectKey}?ttl=${ttl}`;
  }
  async delete() {}
  async ensureReady() {}
}

/** public.test → public IP; private.test → 10.0.0.5; everything else fails. */
export const fakeResolver: Resolver = async (host) => {
  if (host === "shop.example.com" || host === "public.test" || host === "x.com") return ["93.184.215.14"];
  if (host === "private.test") return ["10.0.0.5"];
  throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: "ENOTFOUND" });
};

export interface TestApi {
  app: FastifyInstance;
  deps: ApiDeps;
  tdb: TestDatabase;
  queue: FakeQueue;
  redis: Redis;
  audit: Record<string, unknown>[];
  close(): Promise<void>;
}

export async function createTestApi(
  overrides: Partial<ApiDeps["config"]> = {},
  // `queue` is returned as `TestApi.queue`, so only a FakeQueue is accepted.
  { queue = new FakeQueue(), ...extra }: Partial<Omit<ApiDeps, "config" | "queue">> & { queue?: FakeQueue } = {},
): Promise<TestApi> {
  const tdb = await createTestDatabase();
  const redis = new Redis(REDIS_URL);
  const sub = new Redis(REDIS_URL);
  const hub = new RunEventHub(sub);
  const audit: Record<string, unknown>[] = [];
  const deps: ApiDeps = {
    config: {
      apiToken: API_TOKEN,
      defaultTenantId: TEST_TENANT_ID,
      maxActiveRunsPerTenant: 100,
      privateAllowlist: ["demo-shop:4000"],
      secretsKey: SECRETS_KEY,
      artifactUrlTtlSeconds: 300,
      sseHeartbeatMs: 20_000,
      llm: FAKE_LLM,
      auth: { sessionTtlHours: 12, passwordHashN: 1024 },
      ...overrides,
    },
    db: tdb.db,
    redis,
    hub,
    queue,
    storage: new FakeStorage(),
    cancelSignal: createCancelSignal(redis),
    resolve: fakeResolver,
    audit: (e) => audit.push(e),
  };
  Object.assign(deps, extra);
  const app = await buildApp(deps, { logger: false });
  return {
    app,
    deps,
    tdb,
    queue,
    redis,
    audit,
    async close() {
      await app.close();
      await hub.close();
      redis.disconnect();
      await tdb.drop();
    },
  };
}

export const validBody = (overrides: Record<string, unknown> = {}) => ({
  targetUrl: "https://shop.example.com",
  requirement: "Verify that a user can add a product to the cart.",
  ...overrides,
});
