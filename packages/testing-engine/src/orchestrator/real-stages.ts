import { createExploreStage, type ExploreStageDeps } from "../exploration/explore-stage";
import { createPlanStage } from "../planner/planner";
import { createAnalyzeStage, type RequirementLlm } from "../requirement/compiler";
import { applyNoRerunEvidenceRule } from "../verification/interim-reconcile";
import { verifyStage } from "../verification/verify-stage";
import type { EngineStages } from "./stages";

export interface RealStageDeps {
  /** Structured-output LLM port shared by the analyze and plan stages. */
  llm: RequirementLlm;
  /** Browser sandbox, explorer and persistence for the explore stage (Task 14). */
  exploration: ExploreStageDeps;
}

/**
 * The engine used when a real LLM provider is configured (Ruling R7). Each stage is either real or
 * delegated to `fallback` (the fake engine) until its task lands; later tasks swap one line each.
 */
export function createRealStages(deps: RealStageDeps, fallback: EngineStages): EngineStages {
  return {
    analyze: createAnalyzeStage(deps.llm), // Task 10
    plan: createPlanStage(deps.llm), // Task 12
    explore: createExploreStage(deps.exploration), // Task 14
    verify: verifyStage, // Task 15
    // R7: no generated test until Milestone C, so the rerun is UNAVAILABLE.
    generateTest: async () => null,
    runTest: (ctx, test) => fallback.runTest(ctx, test),
    // Fake until Milestone C. INTERIM (Ruling R26, until Task 18): before it runs, Section 2.3's no-rerun
    // rows apply — a PASS/FAIL not backed only by DOM_VERIFIED facts becomes INCONCLUSIVE /
    // UNVERIFIED_EVIDENCE. Each criterion keeps the verifier's status as its `provisional` record.
    report: async (ctx, input) => {
      const provisional = applyNoRerunEvidenceRule(input.provisional, input.exploration?.facts ?? []);
      const report = await fallback.report(ctx, { ...input, provisional });
      const original = new Map(input.provisional.map((p) => [p.criterionId, { status: p.status, reason: p.reason }]));
      return {
        ...report,
        criteria: report.criteria.map((c) => ({ ...c, provisional: original.get(c.criterionId) ?? c.provisional })),
      };
    },
  };
}
