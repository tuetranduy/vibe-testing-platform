import { loadEnvOrExit } from "@platform/config";
import { createDb, ensureTenant, runMigrations } from "@platform/db";
import { createRunQueue } from "@platform/event-bus";
import { writeFileSync } from "node:fs";
import { Redis } from "ioredis";
import { CancelWatcher } from "./cancel-watcher";
import type { WorkerLogger } from "./deps";
import { createEngine } from "./engine";
import { startWorkers } from "./worker";

const env = loadEnvOrExit();

const levels = ["trace", "debug", "info", "warn", "error", "fatal"];
const min = levels.indexOf(env.LOG_LEVEL);
const log =
  (level: string) =>
  (obj: object, msg?: string) => {
    if (levels.indexOf(level) < min) return;
    const o = obj as Record<string, unknown>;
    const err = o.err instanceof Error ? { message: o.err.message, name: o.err.name } : o.err;
    console.log(JSON.stringify({ level, time: new Date().toISOString(), component: "worker", msg, ...o, err }));
  };
const logger: WorkerLogger = { info: log("info"), warn: log("warn"), error: log("error") };

const handle = createDb(env.DATABASE_URL);
if (process.env.RUN_MIGRATIONS_ON_START !== "false") await runMigrations(handle.db);
await ensureTenant(handle.db, env.DEFAULT_TENANT_ID);

const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const publisher = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3 });
const cancelWatcher = new CancelWatcher(new Redis(env.REDIS_URL, { maxRetriesPerRequest: null }));
const queue = createRunQueue(connection);

// Ruling R7: LLM_PROVIDER=fake → the deterministic fake engine; otherwise real stages as they land
// (Task 10: analyze), with the fake engine standing in for the rest.
const engine = createEngine(env, {
  db: handle.db,
  logger,
  fake: { stepDelayMs: Number(process.env.FAKE_ENGINE_STEP_DELAY_MS ?? 500), explorationSteps: 4 },
});
if (engine.kind === "fake") logger.warn({ engine: "fake" }, "using the fake test engine (LLM_PROVIDER=fake)");
else logger.info({ engine: "real", provider: engine.llm?.provider, model: engine.llm?.model }, "using the real test engine");
const stages = engine.stages;

const workers = await startWorkers(
  {
    config: {
      secretsKey: env.secretsKey,
      analysisTimeoutSeconds: env.ANALYSIS_TIMEOUT_SECONDS,
      heartbeatMs: 10_000,
      staleAfterMs: 60_000,
      confirmationTtlHours: env.CONFIRMATION_TTL_HOURS,
      queuedStaleAfterMs: 10 * 60_000,
      deadlineGraceMs: 60_000,
      timeScale: 1,
    },
    db: handle.db,
    redis: publisher,
    cancelWatcher,
    queue,
    stages,
    logger,
  },
  { connection, concurrency: env.WORKER_CONCURRENCY },
);
logger.info({ concurrency: env.WORKER_CONCURRENCY }, "worker started");

// Liveness file for the container healthcheck.
const alive = () => {
  try {
    writeFileSync("/tmp/worker-alive", String(Date.now()));
  } catch {
    /* read-only fs outside containers is fine */
  }
};
alive();
const aliveTimer = setInterval(alive, 10_000);

const shutdown = async () => {
  logger.info({}, "worker shutting down");
  clearInterval(aliveTimer);
  await workers.close();
  await queue.close();
  cancelWatcher.close();
  publisher.disconnect();
  connection.disconnect();
  await handle.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
