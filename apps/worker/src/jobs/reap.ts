import { EventRepository, RunRepository, SecretRepository, StaleTransitionError, type TestRun } from "@platform/db";
import { createRunEventPublisher } from "@platform/event-bus";
import { redactByKey } from "@platform/security";
import type { WorkerDeps } from "../deps";
import { NO_VERDICT, observeStage } from "../metrics";

export interface ReapResult {
  workerLost: string[];
  timedOut: string[];
  neverStarted: string[];
  confirmationExpired: string[];
  secretsPurged: string[];
}

/** `runs_reaped_total` reason of each category the reaper errors a run with. */
const REAPED_REASON = { WORKER_LOST: "WORKER_LOST", TIMEOUT: "TIMEOUT", INTERNAL: "NEVER_STARTED" } as const;

/**
 * Maintenance (every 60 s):
 *  - active run with a stale heartbeat → ERRORED / WORKER_LOST (unless its execute-run job is still waiting)
 *  - AWAITING_CONFIRMATION past CONFIRMATION_TTL_HOURS → CANCELLED / CONFIRMATION_EXPIRED
 *  - purge secrets of terminal runs (safety net)
 * Losing a CAS race to a live worker is expected and ignored.
 */
export async function reapJob(deps: WorkerDeps): Promise<ReapResult> {
  const now = (deps.now ?? (() => new Date()))();
  const runs = new RunRepository(deps.db);
  const secrets = new SecretRepository(deps.db);
  const publisher = createRunEventPublisher({
    events: new EventRepository(deps.db),
    redis: deps.redis,
    redact: redactByKey,
    logger: deps.logger,
  });
  const result: ReapResult = { workerLost: [], timedOut: [], neverStarted: [], confirmationExpired: [], secretsPurged: [] };

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
    if (await deps.queue.isAnalyzePending(run.id)) continue;
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

  for (const runId of await secrets.findTerminalRunIdsWithActiveSecrets()) {
    if ((await secrets.purge(runId)) > 0) result.secretsPurged.push(runId);
  }
  return result;
}
