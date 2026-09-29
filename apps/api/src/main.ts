import { createLogger, loadEnvOrExit, resolveEnvLlmChoice } from "@platform/config";
import { createDb, ensureTenant, runMigrations } from "@platform/db";
import { DEFAULT_REAPER_CONFIG, RunEventHub, createRunQueue, startReaper } from "@platform/event-bus";
import { defaultResolver } from "@platform/security";
import { createArtifactStorage } from "@platform/storage";
import { Redis } from "ioredis";
import { buildApp } from "./app";
import { createApiMetrics } from "./metrics";
import { createCancelSignal } from "./services/cancel-signal";

const env = loadEnvOrExit();
const log = createLogger({ component: "api", level: env.LOG_LEVEL });

async function retry(fn: () => Promise<void>, what: string, attempts = 30): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts) throw err;
      log.warn({ err, attempt: i, attempts }, `${what} not ready`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

const handle = createDb(env.DATABASE_URL);
if (process.env.RUN_MIGRATIONS_ON_START !== "false") await runMigrations(handle.db);
await ensureTenant(handle.db, env.DEFAULT_TENANT_ID);

const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3 });
const subscriber = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const queueConnection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const queue = createRunQueue(queueConnection);

const storage = createArtifactStorage(env);
await retry(() => storage.ensureReady(), "artifact storage");

const metrics = createApiMetrics({ queue });

const app = await buildApp(
  {
    config: {
      apiToken: env.API_TOKEN,
      defaultTenantId: env.DEFAULT_TENANT_ID,
      maxActiveRunsPerTenant: env.MAX_ACTIVE_RUNS_PER_TENANT,
      privateAllowlist: env.TARGET_PRIVATE_ALLOWLIST,
      secretsKey: env.secretsKey,
      artifactUrlTtlSeconds: 300,
      sseHeartbeatMs: 20_000,
      llm: {
        envChoice: resolveEnvLlmChoice(env),
        envKeys: { anthropic: Boolean(env.ANTHROPIC_API_KEY?.trim()), gemini: Boolean(env.GEMINI_API_KEY?.trim()) },
        fakeAllowed: env.NODE_ENV !== "production",
      },
    },
    db: handle.db,
    redis,
    hub: new RunEventHub(subscriber),
    queue,
    storage,
    cancelSignal: createCancelSignal(redis),
    resolve: defaultResolver,
    metrics,
  },
  { logger: { level: env.LOG_LEVEL, redact: ["req.headers.authorization", "req.headers.cookie"] } },
);

// The reaper runs here as well as in the workers (one of them per tick), so a run whose only worker
// crashed is still ended ERRORED / WORKER_LOST while no worker is up (Section 6: within 2 minutes).
const reaper = await startReaper(
  {
    config: { ...DEFAULT_REAPER_CONFIG, confirmationTtlHours: env.CONFIRMATION_TTL_HOURS },
    db: handle.db,
    redis,
    queue,
    logger: log,
    metrics,
  },
  { connection: queueConnection },
);

const shutdown = async () => {
  await app.close();
  await reaper.close();
  await queue.close();
  redis.disconnect();
  subscriber.disconnect();
  queueConnection.disconnect();
  await handle.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await app.listen({ port: env.API_PORT, host: "0.0.0.0" });
