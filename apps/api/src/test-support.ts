import type { GeneratedTest, NormalizedRequirement } from "@platform/contracts";
import { GeneratedTestRepository, RequirementRepository, RunRepository, UserRepository } from "@platform/db";
import { TEST_TENANT_ID, createTestDatabase, type TestDatabase } from "@platform/db/testing";
import { hashPassword } from "@platform/security";
import { RunEventHub, type RunQueue, type ScheduleSync } from "@platform/event-bus";
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
  rerun: string[] = [];
  rerunPending = new Set<string>();
  async enqueueRerun(runId: string) {
    if ((this as { fail?: boolean }).fail) throw new Error("queue down");
    this.rerun.push(runId);
  }
  async isRerunPending(runId: string) {
    return this.rerunPending.has(runId);
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

/** BullMQ's job schedulers, in memory (V1.2 F3). */
export class FakeScheduleSync implements ScheduleSync {
  schedulers = new Map<string, { cron: string; timezone: string }>();
  async upsert(s: { id: string; cron: string; timezone: string }) {
    this.schedulers.set(s.id, { cron: s.cron, timezone: s.timezone });
  }
  async remove(id: string) {
    this.schedulers.delete(id);
  }
  async ids() {
    return [...this.schedulers.keys()];
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

/** A new member of the test tenant, signed in: their request headers (bearer + session) and id. */
export async function signInMember(t: TestApi, role: "member" | "admin" = "member"): Promise<{ headers: Record<string, string>; userId: string }> {
  const email = `m-${Date.now()}-${Math.random()}@example.com`;
  const user = await new UserRepository(t.tdb.db).create({
    tenantId: TEST_TENANT_ID,
    email,
    name: `Member ${email.slice(2, 8)}`,
    role,
    passwordHash: await hashPassword("member password", { N: 1024 }),
  });
  const res = await t.app.inject({ method: "POST", url: "/v1/auth/login", headers: auth, payload: { email, password: "member password" } });
  return { headers: { ...auth, "x-session-token": res.json().token as string }, userId: user.id };
}

export const SAVED_REQUIREMENT = "Verify that a user can add a product to the cart.";

export const confirmedRequirement = (runId: string): NormalizedRequirement => ({
  runId,
  revision: 1,
  originalText: SAVED_REQUIREMENT,
  criteria: [
    {
      id: "AC-1",
      sourceText: "add a product to the cart",
      statement: "The cart count is 1",
      expectedOutcome: { kind: "numeric_compare", left: { key: "cartCount", checkpoint: "after_add" }, operator: "eq", right: 1 },
      preconditions: [],
      critical: true,
      ambiguity: null,
    },
  ],
  facts: [{ key: "cartCount", checkpoint: "after_add", description: "Cart count", valueType: "number" }],
  confirmedAt: "2026-09-29T10:00:00.000Z",
});

export const savedTest: GeneratedTest = {
  id: "gt_src",
  source: "// the saved test",
  helpersSource: "",
  dataJson: "{}",
  compiledCriteria: ["AC-1"],
  notCompiled: [],
  notes: [],
};

/**
 * A finished (CANCELLED) run created through the API, with a confirmed requirement and a generated test: something
 * a rerun or a suite can rerun. `test: null` leaves the test out.
 */
export async function finishedRunWithTest(
  t: TestApi,
  body: Record<string, unknown> = {},
  opts: { headers?: Record<string, string>; test?: GeneratedTest | null } = {},
): Promise<string> {
  const res = await t.app.inject({
    method: "POST",
    url: "/v1/test-runs",
    headers: opts.headers ?? auth,
    payload: validBody({ requirement: SAVED_REQUIREMENT, ...body }),
  });
  const { runId } = res.json() as { runId: string };
  if (!runId) throw new Error(`run not created: ${res.body}`);
  await new RequirementRepository(t.tdb.db).copyConfirmed(runId, confirmedRequirement(runId));
  if (opts.test !== null) await new GeneratedTestRepository(t.tdb.db).save(runId, { ...(opts.test ?? savedTest), id: `gt_${runId}` });
  await new RunRepository(t.tdb.db).transition(runId, "QUEUED", "CANCELLED", { cancelReason: "USER_REQUESTED" });
  return runId;
}
