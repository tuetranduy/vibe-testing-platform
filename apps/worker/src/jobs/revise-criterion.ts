import { ContractError, ModelProviderError } from "@platform/contracts";
import { RequirementRepository, RunRepository, SiteAnalysisRepository } from "@platform/db";
import type { ProposalBody, ReviseJobData } from "@platform/event-bus";
import { createRunRedactor } from "@platform/security";
import { reviseCriterion } from "@platform/testing-engine";
import type { WorkerDeps } from "../deps";

/** A rewrite answers within this much (the API waits a little longer). */
export const REVISE_TIMEOUT_MS = 55_000;

/** Fails the job with a code the API maps to an answer ("CODE: message", RevisionFailedError). */
const refuse = (code: string, message: string) => new Error(`${code}: ${message}`);

/**
 * revise-criterion (2026-11-19): rewrites one criterion of a run awaiting confirmation from the user's words, with the
 * run's model (`reviseCriterion`). Its return value is the proposal; nothing is saved here: the API saves it when the
 * user accepts it. The model call is recorded with the run (stage AWAITING_CONFIRMATION).
 */
export async function reviseCriterionJob(deps: WorkerDeps, data: ReviseJobData, opts: { timeoutMs?: number } = {}): Promise<ProposalBody> {
  const run = await new RunRepository(deps.db).findById(data.runId);
  if (!run || run.lifecycle !== "AWAITING_CONFIRMATION") throw refuse("NOT_AWAITING_CONFIRMATION", "the run's criteria can only change while it awaits confirmation");
  const latest = await new RequirementRepository(deps.db).findLatest(run.id);
  if (!latest || latest.revision !== data.basedOnRevision) throw refuse("PROPOSAL_STALE", "the criteria changed since the rewrite was asked for");
  if (!latest.criteria.some((c) => c.id === data.criterionId)) throw refuse("UNKNOWN_CRITERION", `there is no criterion ${data.criterionId}`);

  let llm;
  try {
    ({ llm } = await deps.runLlm.forRun(run));
  } catch (err) {
    throw refuse("REVISE_FAILED", err instanceof Error ? err.message : String(err));
  }
  if (!llm) throw refuse("REVISE_NEEDS_MODEL", "the fake engine has no model to rewrite a check");

  const analysis = await new SiteAnalysisRepository(deps.db).get(run.id);
  const signal = AbortSignal.timeout(opts.timeoutMs ?? REVISE_TIMEOUT_MS);
  try {
    const revised = await reviseCriterion(llm, {
      requirement: latest,
      criterionId: data.criterionId,
      instruction: data.instruction,
      testData: run.request.testData,
      secretNames: run.request.secretNames,
      pages: analysis?.pageContents ?? [],
      runId: run.id,
      signal,
      redact: createRunRedactor(),
    });
    return { runId: run.id, criterionId: data.criterionId, basedOnRevision: latest.revision, ...revised };
  } catch (err) {
    // The model's time ran out: a timeout to the API (504), not a provider failure (review finding).
    if (signal.aborted) throw refuse("REVISE_TIMEOUT", "the AI model did not answer in time");
    if (err instanceof ContractError) throw refuse("REVISE_INVALID", "the model's rewrite was not a valid check; try other words");
    if (err instanceof ModelProviderError) throw refuse("REVISE_FAILED", err.message);
    throw err;
  }
}
