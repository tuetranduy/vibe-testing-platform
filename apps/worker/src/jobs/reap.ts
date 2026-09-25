import { EventRepository, RunRepository, SecretRepository, StaleTransitionError, type TestRun } from "@platform/db";
import { createRunEventPublisher } from "@platform/event-bus";
import { redactByKey } from "@platform/security";
import type { WorkerDeps } from "../deps";

export interface ReapResult {
  workerLost: string[];
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
  const result: ReapResult = { workerLost: [], confirmationExpired: [], secretsPurged: [] };

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
      await runs.transition(run.id, run.lifecycle, "ERRORED", {
        errorCategory: "WORKER_LOST",
        errorMessage: "No heartbeat from the worker",
      });
      await secrets.purge(run.id);
      await publisher.publish({
        runId: run.id,
        stage: "ERRORED",
        type: "run.errored",
        message: "Run failed: worker lost",
        payload: { category: "WORKER_LOST", message: "No heartbeat from the worker" },
      });
      result.workerLost.push(run.id);
    });
  }

  const ttlMs = deps.config.confirmationTtlHours * 3_600_000;
  for (const run of await runs.findAwaitingConfirmationSince(new Date(now.getTime() - ttlMs))) {
    await safely(run, async () => {
      await runs.transition(run.id, "AWAITING_CONFIRMATION", "CANCELLED", { cancelReason: "CONFIRMATION_EXPIRED" });
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
