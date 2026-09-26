import { ProvisionalResultSchema, type ProvisionalResult } from "@platform/contracts";
import type { EngineStages } from "../orchestrator/stages";
import { clip } from "./normalize";
import { verifyCriterion } from "./verifier";

/**
 * The real VERIFYING stage: every criterion through the pure verifier (Ruling R16). With no
 * exploration (the PLANNING → GENERATING_REPORT path, every criterion plan-blocked) it verifies over no
 * facts and no steps, with a stop reason that cannot pass for a budget or step limit.
 *
 * `expected` / `actual` can quote recorded page text, so they go through the run's redactor (redact
 * first, then truncate, so a cut can never split a secret past the redactor).
 */
export const verifyStage: EngineStages["verify"] = (ctx, requirement, plan, exploration) => {
  const redactText = (s: string) => clip(String(ctx.redact(s)));
  return requirement.criteria.map((criterion): ProvisionalResult => {
    const r = verifyCriterion({
      criterion,
      facts: exploration?.facts ?? [],
      blocked: plan.blockedCriteria,
      steps: exploration?.steps ?? [],
      stopReason: exploration?.stopReason ?? "COMPLETED",
      plan,
    });
    return ProvisionalResultSchema.parse({ ...r, expected: redactText(r.expected), actual: r.actual === null ? null : redactText(r.actual) });
  });
};
