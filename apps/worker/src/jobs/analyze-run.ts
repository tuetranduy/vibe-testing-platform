import { RequirementRepository, RunRepository, SuggestionRepository, type TestRun } from "@platform/db";
import { runAnalysis, runSurvey } from "@platform/testing-engine";
import type { WorkerDeps } from "../deps";
import { createRunContext, type RunContextHandle } from "../run-context";
import { failBeforeContext, failRun, purgeSecretsIfTerminal } from "./finish";

/**
 * What an analyze-run job does with a run (spec 2026-09-28-suggest-tests, section 5):
 * - "survey": QUEUED with a blank requirement → SURVEYING → AWAITING_SELECTION;
 * - "requirement": QUEUED with a requirement → the analysis, as before;
 * - "selected": ANALYZING_REQUIREMENT after a selection (the set's `selected` is set, no requirement
 *   revision yet) → the analysis of the chosen text, without the QUEUED transition.
 * Anything else — a run that moved on, a duplicate job — is skipped.
 */
type AnalyzeMode = "survey" | "requirement" | "selected";

async function modeOf(deps: WorkerDeps, run: TestRun): Promise<AnalyzeMode | null> {
  if (run.lifecycle === "QUEUED") return run.request.requirement.trim() === "" ? "survey" : "requirement";
  if (run.lifecycle !== "ANALYZING_REQUIREMENT") return null;
  const set = await new SuggestionRepository(deps.db).get(run.id);
  if (!set?.selected) return null;
  return (await new RequirementRepository(deps.db).findLatest(run.id)) ? null : "selected";
}

/**
 * A selected text reached the database through the API, which never has secret plaintext (D7) and
 * can only redact by key. Before any model sees it, mask the run's secret values in it; when that
 * changed it, the masked text is stored as the run's requirement first.
 */
async function redactSelectedText(deps: WorkerDeps, handle: RunContextHandle): Promise<void> {
  const text = handle.ctx.request.requirement;
  const redacted = String(handle.ctx.redact(text));
  if (redacted === text) return;
  await new RunRepository(deps.db).setRequirement(handle.ctx.runId, redacted);
  handle.ctx.request = { ...handle.ctx.request, requirement: redacted };
}

/** analyze-run: the survey of a blank-requirement run, or the analysis of a requirement (see AnalyzeMode). */
export async function analyzeRunJob(deps: WorkerDeps, runId: string): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const run = await new RunRepository(deps.db).findById(runId);
  const mode = run ? await modeOf(deps, run) : null;
  if (!run || !mode) {
    deps.logger.info({ runId, tenantId: run?.tenantId, stage: run?.lifecycle }, "analyze-run skipped: nothing to survey or analyze");
    return;
  }
  deps.metrics?.activeRuns.inc();
  try {
    // The survey's hard deadline is SURVEY_TIMEOUT_SECONDS; its page loading gets 60 % of it
    // (createRunContext's budgets.explorationMs), the rest is for the model call.
    const seconds = mode === "survey" ? deps.config.surveyTimeoutSeconds : deps.config.analysisTimeoutSeconds;
    const budgetMs = seconds * 1000 * deps.config.timeScale;
    let handle: RunContextHandle;
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
      const stages = deps.engines.for(handle.choice);
      if (mode === "survey") {
        await runSurvey(handle.ctx, handle.ports, stages);
      } else {
        if (mode === "selected") await redactSelectedText(deps, handle);
        await runAnalysis(handle.ctx, handle.ports, stages);
      }
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
