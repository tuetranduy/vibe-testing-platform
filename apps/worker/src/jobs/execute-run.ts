import { RunRepository } from "@platform/db";
import { runExecution } from "@platform/testing-engine";
import type { WorkerDeps } from "../deps";
import { createRunContext } from "../run-context";
import { failBeforeContext, failRun, purgeSecretsIfTerminal } from "./finish";

/** execute-run: PLANNING → … → COMPLETED, or CANCELLED / ERRORED. */
export async function executeRunJob(deps: WorkerDeps, runId: string): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const runs = new RunRepository(deps.db);
  const run = await runs.findById(runId);
  if (!run || run.lifecycle !== "PLANNING") {
    deps.logger.info({ runId, tenantId: run?.tenantId, stage: run?.lifecycle }, "execute-run skipped: run is not PLANNING");
    return;
  }
  deps.metrics?.activeRuns.inc();
  try {
    // The maxRunSeconds clock starts here (time spent awaiting confirmation doesn't count).
    const totalBudgetMs = run.request.options.maxRunSeconds * 1000 * deps.config.timeScale;
    const startedAt = now();
    const deadlineAt = new Date(startedAt.getTime() + totalBudgetMs);
    await runs.markExecutionStarted(runId, { deadlineAt, startedAt });

    let handle;
    try {
      handle = await createRunContext(deps, run, { deadlineAt, totalBudgetMs });
    } catch (err) {
      await failBeforeContext(deps, run, err);
      return;
    }
    try {
      const { verdict } = await runExecution(handle.ctx, handle.ports, deps.engines.for(handle.choice));
      deps.logger.info({ runId, verdict }, "run completed");
    } catch (err) {
      await failRun(deps, handle, err);
    } finally {
      await handle.dispose();
      await purgeSecretsIfTerminal(deps, runId);
    }
  } finally {
    deps.metrics?.activeRuns.dec();
  }
}
