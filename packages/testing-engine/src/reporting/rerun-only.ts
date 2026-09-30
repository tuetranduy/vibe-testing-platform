import {
  CriterionResultSchema,
  describeExpectedOutcome,
  factRefsOf,
  type CriterionResult,
  type GeneratedTest,
  type NormalizedRequirement,
  type RerunOutcome,
  type RerunResult,
  type StatusReason,
} from "@platform/contracts";
import { clip } from "../verification/normalize";

/**
 * A manual rerun's results (V1.1 F5, D2 amended for rerun-only runs): the saved Playwright test is the only
 * evidence, so each criterion's status comes from its own assertion in this rerun. Pure.
 *
 * | Criterion                         | Rerun outcome              | Status        | verdictSource    | Reason                 |
 * |-----------------------------------|----------------------------|---------------|------------------|------------------------|
 * | compiled                          | PASSED                     | PASS          | PLAYWRIGHT_RERUN | —                      |
 * | compiled                          | ASSERTION_FAILED           | FAIL          | PLAYWRIGHT_RERUN | —                      |
 * | compiled                          | NOT_REACHED / UNAVAILABLE  | INCONCLUSIVE  | —                | RERUN_NOT_REACHED      |
 * | not in the generated test         | any                        | INCONCLUSIVE  | —                | NOT_IN_GENERATED_TEST  |
 *
 * A rerun that ERRORed reports its compiled criteria NOT_REACHED, so they end INCONCLUSIVE: an
 * infrastructure failure is never a FAIL. `provisional` repeats the final status: a rerun-only run has no
 * discovery result. The rerun's error text (already redacted by the stage) becomes `actual`, and its evidence
 * belongs to every criterion it did not pass.
 */
export function rerunOnlyResults(requirement: NormalizedRequirement, test: GeneratedTest, rerun: RerunResult): CriterionResult[] {
  const compiled = new Set(test.compiledCriteria);
  return requirement.criteria.map((c) => {
    const outcome: RerunOutcome = compiled.has(c.id) ? (rerun.perCriterion[c.id] ?? "NOT_REACHED") : "UNAVAILABLE";
    let status: CriterionResult["status"];
    let reason: StatusReason | null = null;
    if (!compiled.has(c.id)) {
      status = "INCONCLUSIVE";
      reason = "NOT_IN_GENERATED_TEST";
    } else if (outcome === "PASSED") {
      status = "PASS";
    } else if (outcome === "ASSERTION_FAILED") {
      status = "FAIL";
    } else {
      status = "INCONCLUSIVE";
      reason = "RERUN_NOT_REACHED";
    }
    const decided = status === "PASS" || status === "FAIL";
    const errorText = rerun.errorText[c.id];
    return CriterionResultSchema.parse({
      criterionId: c.id,
      status,
      reason,
      factRefs: factRefsOf(c.expectedOutcome).map(({ ref }) => ref),
      expected: clip(describeExpectedOutcome(c.expectedOutcome, requirement.facts)),
      actual: status === "PASS" ? "As expected in the rerun" : errorText ? clip(`Rerun: ${errorText}`) : null,
      verdictSource: decided ? "PLAYWRIGHT_RERUN" : null,
      rerunOutcome: outcome,
      provisional: { status, reason },
      evidenceArtifactIds: compiled.has(c.id) ? rerun.artifactIds : [],
      relatedStepIds: [],
      aiNote: null,
      critical: c.critical,
    });
  });
}
