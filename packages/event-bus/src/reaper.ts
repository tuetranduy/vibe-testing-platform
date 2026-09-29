import { EventRepository, RunRepository, SecretRepository, StaleTransitionError, type Database, type TestRun } from "@platform/db";
import { redactByKey } from "@platform/security";
import { Queue, Worker, type ConnectionOptions } from "bullmq";
import type { Redis } from "ioredis";
import { createRunEventPublisher } from "./publisher";
import { JOB_REAP, MAINTENANCE_QUEUE, type RunQueue } from "./queues";

/**
 * The reaper: ends runs nobody will finish. It lives here, not in the worker, because it must keep
 * running when every worker is gone — that is when it is needed most (a crashed worker's runs end
 * ERRORED / WORKER_LOST). The workers and the API both consume the `maintenance` queue; its job
 * scheduler makes exactly one of them run each tick.
 */

/** How often the reaper runs. With a 60 s stale threshold, a lost run is ended within about 90 s. */
export const REAP_EVERY_MS = 30_000;

/** `verdict` label of runs that ended without one (the workers' and the API's NO_VERDICT). */
const NO_VERDICT = "none";

export interface ReaperConfig {
  /** A run whose heartbeat is older than this is considered lost (WORKER_LOST). */
  staleAfterMs: number;
  confirmationTtlHours: number;
  /** A QUEUED run older than this whose analyze job isn't pending was never picked up. */
  queuedStaleAfterMs: number;
  /** Grace after `deadlineAt` before the reaper times out a run whose worker didn't. */
  deadlineGraceMs: number;
}

/** The production values (the worker's heartbeat beats every 10 s). */
export const DEFAULT_REAPER_CONFIG: Omit<ReaperConfig, "confirmationTtlHours"> = {
  staleAfterMs: 60_000,
  queuedStaleAfterMs: 10 * 60_000,
  deadlineGraceMs: 60_000,
};

/** The counters the reaper feeds; prom-client's Counter / Histogram fit. Both processes export them. */
export interface ReaperMetrics {
  testRuns: { inc(labels: { lifecycle: string; verdict: string }): void };
  runsReaped: { inc(labels: { reason: string }): void };
  runDuration: { observe(labels: { stage: string }, seconds: number): void };
}

export interface ReaperLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface ReaperDeps {
  config: ReaperConfig;
  db: Database;
  redis: Pick<Redis, "publish">;
  queue: Pick<RunQueue, "isExecuteWaiting" | "isAnalyzeAfterSelectionWaiting" | "isAnalyzePending" | "isRerunPending">;
  logger: ReaperLogger;
  metrics?: ReaperMetrics;
  now?: () => Date;
}

function observeStage(metrics: ReaperMetrics | undefined, stage: string, enteredAt: Date, leftAt: Date): void {
  metrics?.runDuration.observe({ stage }, Math.max(0, leftAt.getTime() - enteredAt.getTime()) / 1000);
}

export interface ReapResult {
  workerLost: string[];
  timedOut: string[];
  neverStarted: string[];
  confirmationExpired: string[];
  selectionExpired: string[];
  secretsPurged: string[];
}

/** `runs_reaped_total` reason of each category the reaper errors a run with. */
const REAPED_REASON = { WORKER_LOST: "WORKER_LOST", TIMEOUT: "TIMEOUT", INTERNAL: "NEVER_STARTED" } as const;

/**
 * Maintenance (every 30 s, REAP_EVERY_MS; run by the workers and the API, one of them per tick):
 *  - active run with a stale heartbeat → ERRORED / WORKER_LOST (unless the job that will pick it up is still
 *    waiting: PLANNING's execute-run, or the post-selection analyze-run of an ANALYZING_REQUIREMENT run)
 *  - AWAITING_CONFIRMATION past CONFIRMATION_TTL_HOURS → CANCELLED / CONFIRMATION_EXPIRED
 *  - AWAITING_SELECTION past CONFIRMATION_TTL_HOURS → CANCELLED / SELECTION_EXPIRED
 *  - purge secrets of terminal runs (safety net)
 * Losing a CAS race to a live worker is expected and ignored.
 */
export async function reapRuns(deps: ReaperDeps): Promise<ReapResult> {
  const now = (deps.now ?? (() => new Date()))();
  const runs = new RunRepository(deps.db);
  const secrets = new SecretRepository(deps.db);
  const publisher = createRunEventPublisher({
    events: new EventRepository(deps.db),
    redis: deps.redis,
    redact: redactByKey,
    logger: deps.logger,
  });
  const result: ReapResult = { workerLost: [], timedOut: [], neverStarted: [], confirmationExpired: [], selectionExpired: [], secretsPurged: [] };

  // Each run is counted as soon as it is ended, so a pass that fails later still counts it.
  const errorRun = async (run: TestRun, category: keyof typeof REAPED_REASON, message: string) => {
    await runs.transition(run.id, run.lifecycle, "ERRORED", { errorCategory: category, errorMessage: message });
    observeStage(deps.metrics, run.lifecycle, run.lifecycleChangedAt, now);
    deps.metrics?.testRuns.inc({ lifecycle: "ERRORED", verdict: NO_VERDICT });
    deps.metrics?.runsReaped.inc({ reason: REAPED_REASON[category] });
    await secrets.purge(run.id);
    await publisher.publish({
      runId: run.id,
      stage: "ERRORED",
      type: "run.errored",
      message: `Run failed: ${category}`,
      payload: { category, message },
    });
  };

  const safely = async (run: TestRun, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      if (err instanceof StaleTransitionError) return;
      deps.logger.error({ err, runId: run.id }, "reaper failed on run");
    }
  };

  for (const run of await runs.findStale(new Date(now.getTime() - deps.config.staleAfterMs))) {
    if (run.lifecycle === "PLANNING" && (await deps.queue.isExecuteWaiting(run.id))) continue;
    // After a selection the API moves the run to ANALYZING_REQUIREMENT before any worker holds it.
    if (run.lifecycle === "ANALYZING_REQUIREMENT" && (await deps.queue.isAnalyzeAfterSelectionWaiting(run.id))) continue;
    await safely(run, async () => {
      await errorRun(run, "WORKER_LOST", "No heartbeat from the worker");
      result.workerLost.push(run.id);
    });
  }

  // Hard deadline backstop: the worker enforces it, this catches a worker that doesn't.
  for (const run of await runs.findPastDeadline(new Date(now.getTime() - deps.config.deadlineGraceMs))) {
    await safely(run, async () => {
      await errorRun(run, "TIMEOUT", "Hard deadline exceeded");
      result.timedOut.push(run.id);
    });
  }

  // QUEUED runs whose analyze job is gone (worker died before picking it up, enqueue lost, ...).
  for (const run of await runs.findQueuedSince(new Date(now.getTime() - deps.config.queuedStaleAfterMs))) {
    // A manual rerun (V1.1 F5) waits for its rerun-run job, not an analyze-run.
    if (run.request.rerunOf ? await deps.queue.isRerunPending(run.id) : await deps.queue.isAnalyzePending(run.id)) continue;
    await safely(run, async () => {
      await errorRun(run, "INTERNAL", "Run was never picked up by a worker");
      result.neverStarted.push(run.id);
    });
  }

  const ttlMs = deps.config.confirmationTtlHours * 3_600_000;
  for (const run of await runs.findAwaitingConfirmationSince(new Date(now.getTime() - ttlMs))) {
    await safely(run, async () => {
      await runs.transition(run.id, "AWAITING_CONFIRMATION", "CANCELLED", { cancelReason: "CONFIRMATION_EXPIRED" });
      observeStage(deps.metrics, "AWAITING_CONFIRMATION", run.lifecycleChangedAt, now);
      deps.metrics?.testRuns.inc({ lifecycle: "CANCELLED", verdict: NO_VERDICT });
      deps.metrics?.runsReaped.inc({ reason: "CONFIRMATION_EXPIRED" });
      await secrets.purge(run.id);
      await publisher.publish({
        runId: run.id,
        stage: "CANCELLED",
        type: "run.cancelled",
        message: "Run cancelled: criteria were not confirmed in time",
        payload: { reason: "CONFIRMATION_EXPIRED" },
      });
      result.confirmationExpired.push(run.id);
    });
  }

  // A blank-requirement run whose suggested tests nobody chose: the same TTL as a confirmation.
  for (const run of await runs.findAwaitingSelectionSince(new Date(now.getTime() - ttlMs))) {
    await safely(run, async () => {
      await runs.transition(run.id, "AWAITING_SELECTION", "CANCELLED", { cancelReason: "SELECTION_EXPIRED" });
      observeStage(deps.metrics, "AWAITING_SELECTION", run.lifecycleChangedAt, now);
      deps.metrics?.testRuns.inc({ lifecycle: "CANCELLED", verdict: NO_VERDICT });
      deps.metrics?.runsReaped.inc({ reason: "SELECTION_EXPIRED" });
      await secrets.purge(run.id);
      await publisher.publish({
        runId: run.id,
        stage: "CANCELLED",
        type: "run.cancelled",
        message: "Run cancelled: no suggested test was chosen in time",
        payload: { reason: "SELECTION_EXPIRED" },
      });
      result.selectionExpired.push(run.id);
    });
  }

  for (const runId of await secrets.findTerminalRunIdsWithActiveSecrets()) {
    if ((await secrets.purge(runId)) > 0) result.secretsPurged.push(runId);
  }
  return result;
}

export interface RunningReaper {
  close(): Promise<void>;
}

/**
 * Registers the reaper's schedule (idempotent: every process upserts the same one) and consumes the
 * `maintenance` queue. Call it from every worker and from the API.
 */
export async function startReaper(
  deps: ReaperDeps,
  opts: { connection: ConnectionOptions; everyMs?: number },
): Promise<RunningReaper> {
  const queue = new Queue(MAINTENANCE_QUEUE, { connection: opts.connection });
  await queue.upsertJobScheduler(
    JOB_REAP,
    { every: opts.everyMs ?? REAP_EVERY_MS },
    { name: JOB_REAP, opts: { attempts: 1, removeOnComplete: 100, removeOnFail: 100 } },
  );
  const worker = new Worker(
    MAINTENANCE_QUEUE,
    async (job) => {
      if (job.name !== JOB_REAP) return;
      const r = await reapRuns(deps);
      if (Object.values(r).some((ids) => ids.length > 0)) deps.logger.info(r, "reaper acted");
    },
    { connection: opts.connection, concurrency: 1, maxStalledCount: 0 },
  );
  worker.on("failed", (job, err) => deps.logger.error({ job: job?.name, err }, "job failed"));
  worker.on("error", (err) => deps.logger.error({ err }, "reaper error"));
  return {
    async close() {
      await worker.close();
      await queue.close();
    },
  };
}
