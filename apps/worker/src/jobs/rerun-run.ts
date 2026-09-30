import { RunRepository } from "@platform/db";
import { runRerunOnly } from "@platform/testing-engine";
import type { WorkerDeps } from "../deps";
import { createRunContext } from "../run-context";
import { failBeforeContext, failRun, purgeSecretsIfTerminal } from "./finish";

/**
 * rerun-run (V1.1 F5): a manual rerun of another run's saved Playwright test. QUEUED → RUNNING_PLAYWRIGHT →
 * GENERATING_REPORT → COMPLETED, or CANCELLED / ERRORED. No model client is built and no model call is made;
 * the engine is the one the run's recorded choice names (the fake engine's rerun for fake runs).
 */
export async function rerunRunJob(deps: WorkerDeps, runId: string): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const runs = new RunRepository(deps.db);
  const run = await runs.findById(runId);
  if (!run || run.lifecycle !== "QUEUED" || !run.request.rerunOf) {
    deps.logger.info({ runId, tenantId: run?.tenantId, stage: run?.lifecycle }, "rerun-run skipped: not a queued rerun");
    return;
  }
  deps.metrics?.activeRuns.inc();
  try {
    const totalBudgetMs = run.request.options.maxRunSeconds * 1000 * deps.config.timeScale;
    const startedAt = now();
    const deadlineAt = new Date(startedAt.getTime() + totalBudgetMs);
    await runs.markExecutionStarted(runId, { deadlineAt, startedAt });

    let handle;
    try {
      // Nothing explores and nothing runs before the rerun: it may use the whole budget, less the reserve
      // rerunTimeoutMs keeps for evidence and the report.
      handle = await createRunContext(deps, run, {
        deadlineAt,
        totalBudgetMs,
        withoutModel: true,
        budgets: { explorationMs: 0, rerunMs: totalBudgetMs },
      });
    } catch (err) {
      await failBeforeContext(deps, run, err);
      return;
    }
    try {
      const verdict = await runRerunOnly(handle.ctx, handle.ports, deps.engines.for(handle.choice));
      deps.logger.info({ runId, verdict }, "rerun completed");
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
