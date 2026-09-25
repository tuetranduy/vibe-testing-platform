import { RunRepository } from "@platform/db";
import { runAnalysis } from "@platform/testing-engine";
import type { WorkerDeps } from "../deps";
import { createRunContext } from "../run-context";
import { failBeforeContext, failRun, purgeSecretsIfTerminal } from "./finish";

/** analyze-run: QUEUED → ANALYZING_REQUIREMENT → AWAITING_CONFIRMATION | PLANNING (+ execute-run). */
export async function analyzeRunJob(deps: WorkerDeps, runId: string): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const run = await new RunRepository(deps.db).findById(runId);
  if (!run || run.lifecycle !== "QUEUED") {
    deps.logger.info({ runId, lifecycle: run?.lifecycle }, "analyze-run skipped: run is not QUEUED");
    return;
  }
  const budgetMs = deps.config.analysisTimeoutSeconds * 1000 * deps.config.timeScale;
  let handle;
  try {
    handle = await createRunContext(deps, run, {
      deadlineAt: new Date(now().getTime() + budgetMs),
      totalBudgetMs: budgetMs,
    });
  } catch (err) {
    await failBeforeContext(deps, run, err);
    return;
  }
  try {
    await runAnalysis(handle.ctx, handle.ports, deps.stages);
  } catch (err) {
    await failRun(deps, handle, err);
  } finally {
    await handle.dispose();
    await purgeSecretsIfTerminal(deps, runId);
  }
}
