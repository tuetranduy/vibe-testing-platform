import { createLogger, createRunLogRegistry, loadEnvOrExit, resolveEnvLlmChoice } from "@platform/config";
import { createDb, ensureTenant, runMigrations } from "@platform/db";
import { DEFAULT_REAPER_CONFIG, createRunQueue } from "@platform/event-bus";
import type { LlmTransport } from "@platform/llm";
import { createArtifactStorage } from "@platform/storage";
import { writeFileSync } from "node:fs";
import { Redis } from "ioredis";
import { CancelWatcher } from "./cancel-watcher";
import type { WorkerLogger } from "./deps";
import { createEngines, rerunWorkspaceConfig, type EngineDeps } from "./engine";
import { stagehandExtension } from "./exploration";
import { createWorkerMetrics, startMetricsServer } from "./metrics";
import { createRunLlmFactory } from "./run-llm";
import { preflightBrowserSandbox, preflightRunner } from "./sandbox/preflight";
import { startWorkers } from "./worker";

export interface BootOptions {
  /**
   * Test seams (E2E): a scripted model transport (every run's client uses it, after the usual key checks) and
   * explorer instead of the provider and Stagehand.
   */
  engine?: Pick<EngineDeps, "exploration" | "rerun"> & { transport?: LlmTransport };
}

/** The worker process: env, database, queues, engine, metrics, retention, signals. */
export async function bootWorker(opts: BootOptions = {}): Promise<void> {
  const env = loadEnvOrExit();

  const runLogs = createRunLogRegistry();
  const logger: WorkerLogger = createLogger({ component: "worker", level: env.LOG_LEVEL, runs: runLogs });

  const metrics = createWorkerMetrics();
  if (env.WORKER_METRICS_PORT > 0) {
    const server = await startMetricsServer(metrics.registry, env.WORKER_METRICS_PORT);
    logger.info({ port: server.port }, "metrics listening");
  }

  const handle = createDb(env.DATABASE_URL);
  if (process.env.RUN_MIGRATIONS_ON_START !== "false") await runMigrations(handle.db);
  await ensureTenant(handle.db, env.DEFAULT_TENANT_ID);

  const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const publisher = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3 });
  const cancelWatcher = new CancelWatcher(new Redis(env.REDIS_URL, { maxRetriesPerRequest: null }));
  const queue = createRunQueue(connection);

  // Exploration screenshots (the real engine); the API signs read URLs for the same store.
  const storage = createArtifactStorage(env);

  // Each run's model comes from its recorded choice (Settings, the new-test form), or from LLM_* for runs
  // without one. Throws here for LLM_PROVIDER=openai (not built in V1): the worker stops at start-up.
  const { transport, ...seams } = opts.engine ?? {};
  const runLlm = createRunLlmFactory({ db: handle.db, secretsKey: env.secretsKey, env, logger, metrics, ...(transport ? { transport } : {}) });
  // Ruling R7, per run: both engines, built once; a run whose choice is the fake engine runs the fake stages.
  const engines = createEngines(env, {
    db: handle.db,
    logger,
    storage,
    metrics,
    fake: { stepDelayMs: Number(process.env.FAKE_ENGINE_STEP_DELAY_MS ?? 500), explorationSteps: 4 },
    ...seams,
  });
  logger.info({ defaults: resolveEnvLlmChoice(env) }, "test engines ready");
  for (let attempt = 1; ; attempt++) {
    try {
      await storage.ensureReady();
      break;
    } catch (err) {
      if (attempt >= 10) throw err;
      logger.warn({ err, attempt }, "artifact storage not ready; retrying");
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  // Launch + close the sandboxed Chromium once. A failure is logged (never fatal): analyze/plan keep
  // working and exploring runs end ERRORED / BROWSER_PROVIDER.
  await preflightBrowserSandbox({ logger, resolveExtension: stagehandExtension });
  // The rerun's runner: @playwright/test resolves and the workspace dir is writable. Logged, never
  // fatal: reruns end ERRORED and criteria fall back to their exploration evidence.
  await preflightRunner({ logger, workspace: rerunWorkspaceConfig(env) });

  const workers = await startWorkers(
    {
      config: {
        secretsKey: env.secretsKey,
        analysisTimeoutSeconds: env.ANALYSIS_TIMEOUT_SECONDS,
        surveyTimeoutSeconds: env.SURVEY_TIMEOUT_SECONDS,
        heartbeatMs: 10_000,
        ...DEFAULT_REAPER_CONFIG,
        confirmationTtlHours: env.CONFIRMATION_TTL_HOURS,
        timeScale: 1,
      },
      db: handle.db,
      redis: publisher,
      cancelWatcher,
      queue,
      engines,
      runLlm,
      logger,
      runLogs,
      metrics,
      storage,
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
}
