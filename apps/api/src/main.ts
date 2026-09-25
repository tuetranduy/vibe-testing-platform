import { loadEnvOrExit } from "@platform/config";
import { createDb, ensureTenant, runMigrations } from "@platform/db";
import { RunEventHub, createRunQueue } from "@platform/event-bus";
import { defaultResolver } from "@platform/security";
import { createArtifactStorage } from "@platform/storage";
import { Redis } from "ioredis";
import { buildApp } from "./app";
import { createCancelSignal } from "./services/cancel-signal";

async function retry(fn: () => Promise<void>, what: string, attempts = 30): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts) throw err;
      console.warn(`${what} not ready (attempt ${i}/${attempts}): ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

const env = loadEnvOrExit();
const handle = createDb(env.DATABASE_URL);
if (process.env.RUN_MIGRATIONS_ON_START !== "false") await runMigrations(handle.db);
await ensureTenant(handle.db, env.DEFAULT_TENANT_ID);

const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3 });
const subscriber = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const queueConnection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const queue = createRunQueue(queueConnection);

const storage = createArtifactStorage(env);
await retry(() => storage.ensureReady(), "artifact storage");

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
    },
    db: handle.db,
    redis,
    hub: new RunEventHub(subscriber),
    queue,
    storage,
    cancelSignal: createCancelSignal(redis),
    resolve: defaultResolver,
  },
  { logger: { level: env.LOG_LEVEL, redact: ["req.headers.authorization", "req.headers.cookie"] } },
);

const shutdown = async () => {
  await app.close();
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
