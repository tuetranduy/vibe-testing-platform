import { EventRepository, RunRepository, SecretRepository, StaleTransitionError, type TestRun } from "@platform/db";
import { createRunEventPublisher } from "@platform/event-bus";
import { redactByKey } from "@platform/security";
import type { WorkerDeps } from "../deps";
import { NO_VERDICT } from "../metrics";

export interface ReapResult {
  workerLost: string[];
  timedOut: string[];
  neverStarted: string[];
  confirmationExpired: string[];
  secretsPurged: string[];
}

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

  const errorRun = async (run: TestRun, category: "WORKER_LOST" | "TIMEOUT" | "INTERNAL", message: string) => {
    await runs.transition(run.id, run.lifecycle, "ERRORED", { errorCategory: category, errorMessage: message });
    deps.metrics?.testRuns.inc({ lifecycle: "ERRORED", verdict: NO_VERDICT });
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
      deps.metrics?.testRuns.inc({ lifecycle: "CANCELLED", verdict: NO_VERDICT });
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
  const reaped: Record<string, number> = {
    WORKER_LOST: result.workerLost.length,
    TIMEOUT: result.timedOut.length,
    NEVER_STARTED: result.neverStarted.length,
    CONFIRMATION_EXPIRED: result.confirmationExpired.length,
  };
  for (const [reason, n] of Object.entries(reaped)) if (n > 0) deps.metrics?.runsReaped.inc({ reason }, n);
  return result;
}
