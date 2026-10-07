import { ProvisionalResultSchema, scenarioOfCriterion, stepScenario, type ProvisionalResult } from "@platform/contracts";
import type { EngineStages } from "../orchestrator/stages";
import { generatedTestData } from "../shared/generated-inputs";
import { resolveTestDataValues } from "../shared/test-data-values";
import { clip } from "./normalize";
import { verifyCriterion } from "./verifier";

/**
 * The real VERIFYING stage: every criterion through the pure verifier (Ruling R16). With no
 * exploration (the PLANNING → GENERATING_REPORT path, every criterion plan-blocked) it verifies over no
 * facts and no steps, with a stop reason that cannot pass for a budget or step limit.
 *
 * `expected` / `actual` can quote recorded page text, so they go through the run's redactor (redact
 * first, then truncate, so a cut can never split a secret past the redactor).
 *
 * Several scenarios (V1.1 F9): a criterion is judged on its own scenario only — that scenario's steps, stop
 * reason and planned steps (a login in another scenario never signs it in). Facts are keyed by checkpoint,
 * which the plan captures exactly once, so they are shared.
 *
 * A text check's test data key is judged against the run's value for it (resolveTestDataValues, KI-001): the value
 * given, else the one a fill generated for it (2026-10-07).
 */
export const verifyStage: EngineStages["verify"] = (ctx, stored, plan, exploration) => {
  const requirement = resolveTestDataValues(stored, { ...generatedTestData(exploration?.steps ?? []), ...(ctx.request.testData ?? {}) });
  const redactText = (s: string) => clip(String(ctx.redact(s)));
  const several = plan.scenarios.length > 1;
  return requirement.criteria.map((criterion): ProvisionalResult => {
    const scenario = scenarioOfCriterion(plan, criterion.id);
    const steps = exploration?.steps ?? [];
    const r = verifyCriterion({
      criterion,
      facts: exploration?.facts ?? [],
      blocked: plan.blockedCriteria,
      steps: several ? steps.filter((s) => stepScenario(s) === scenario.id) : steps,
      stopReason: (several ? exploration?.scenarioStops?.[scenario.id] : undefined) ?? exploration?.stopReason ?? "COMPLETED",
      plan: several ? { ...plan, scenarios: [scenario] } : plan,
    });
    return ProvisionalResultSchema.parse({ ...r, expected: redactText(r.expected), actual: r.actual === null ? null : redactText(r.actual) });
  });
};
