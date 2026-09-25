import { isTerminalLifecycle } from "@platform/contracts";
import { RunRepository, SecretRepository, StaleTransitionError } from "@platform/db";
import { CancelledError, errorCategoryOf, errorMessageOf } from "@platform/testing-engine";
import type { WorkerDeps } from "../deps";
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
    deps.logger.error({ runId: ctx.runId, category, err: message }, "run errored");
  } catch (e) {
    if (e instanceof StaleTransitionError) return;
    throw e;
  }
}

export async function purgeSecretsIfTerminal(deps: WorkerDeps, runId: string): Promise<void> {
  const run = await new RunRepository(deps.db).findById(runId);
  if (run && isTerminalLifecycle(run.lifecycle)) await new SecretRepository(deps.db).purge(runId);
}
