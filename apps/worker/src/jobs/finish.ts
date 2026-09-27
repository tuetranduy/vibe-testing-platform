import { isTerminalLifecycle } from "@platform/contracts";
import { EventRepository, RunRepository, SecretRepository, StaleTransitionError, type TestRun } from "@platform/db";
import { createRunEventPublisher } from "@platform/event-bus";
import { redactByKey } from "@platform/security";
import { CancelledError, errorCategoryOf, errorMessageOf } from "@platform/testing-engine";
import type { WorkerDeps } from "../deps";
import { NO_VERDICT, observeStage } from "../metrics";
import type { RunContextHandle } from "../run-context";

/**
 * Ends a run that threw: CANCELLED for cancellation, ERRORED (+category) for everything else.
 * Infrastructure errors never produce criterion FAIL. A lost CAS race means someone else
 * (the reaper, the cancel endpoint) already ended the run — that's fine.
 */
export async function failRun(deps: WorkerDeps, handle: RunContextHandle, err: unknown): Promise<void> {
  const { ports, ctx } = handle;
  if (err instanceof StaleTransitionError) {
    deps.logger.warn({ runId: ctx.runId, err: err.message }, "run changed underneath the worker; stopping");
    return;
  }
  if (isTerminalLifecycle(ports.lifecycle())) return;
  const reason = handle.abortReason() ?? err;
  try {
    if (reason instanceof CancelledError) {
      const run = await new RunRepository(deps.db).getById(ctx.runId);
      const cancelReason = run.cancelReason ?? "USER_REQUESTED";
      await ports.transition("CANCELLED", { cancelReason });
      await ports.publish({ type: "run.cancelled", message: "Run cancelled", payload: { reason: cancelReason } });
      deps.logger.info({ runId: ctx.runId }, "run cancelled");
      return;
    }
    const category = errorCategoryOf(reason);
    const message = String(ctx.redact(errorMessageOf(reason)));
    await ports.transition("ERRORED", { errorCategory: category, errorMessage: message });
    await ports.publish({ type: "run.errored", message: `Run failed: ${category}`, payload: { category, message } });
    // The error itself (stack, cause chain): the run's log scope redacts its secret values.
    deps.logger.error({ runId: ctx.runId, category, err: reason }, "run errored");
  } catch (e) {
    if (e instanceof StaleTransitionError) return;
    throw e;
  }
}

export async function purgeSecretsIfTerminal(deps: WorkerDeps, runId: string): Promise<void> {
  const run = await new RunRepository(deps.db).findById(runId);
  if (run && isTerminalLifecycle(run.lifecycle)) await new SecretRepository(deps.db).purge(runId);
}

/**
 * The run context itself could not be built (e.g. secrets fail to decrypt, DB/Redis error).
 * End the run as ERRORED so it doesn't sit in QUEUED / PLANNING forever.
 */
export async function failBeforeContext(deps: WorkerDeps, run: TestRun, err: unknown): Promise<void> {
  const category = errorCategoryOf(err);
  const message = "Run could not be started by the worker";
  deps.logger.error({ runId: run.id, tenantId: run.tenantId, stage: run.lifecycle, category, err }, message);
  try {
    await new RunRepository(deps.db).transition(run.id, run.lifecycle, "ERRORED", { errorCategory: category, errorMessage: message });
    observeStage(deps.metrics, run.lifecycle, run.lifecycleChangedAt, (deps.now ?? (() => new Date()))());
    deps.metrics?.testRuns.inc({ lifecycle: "ERRORED", verdict: NO_VERDICT });
    await new SecretRepository(deps.db).purge(run.id);
    await createRunEventPublisher({ events: new EventRepository(deps.db), redis: deps.redis, redact: redactByKey }).publish({
      runId: run.id,
      stage: "ERRORED",
      type: "run.errored",
      message: `Run failed: ${category}`,
      payload: { category, message },
    });
  } catch (e) {
    if (!(e instanceof StaleTransitionError)) throw e;
  }
}
