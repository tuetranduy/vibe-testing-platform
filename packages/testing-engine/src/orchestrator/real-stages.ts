import { createGenerateTestStage, type GenerateTestStageDeps } from "../compiler/generate-stage";
import { createExploreStage, type ExploreStageDeps } from "../exploration/explore-stage";
import { createRunTestStage, type RunTestStageDeps } from "../playwright-runner/run-stage";
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
  /** Persistence for the generated test (Task 16, Ruling R28). */
  generateTest: GenerateTestStageDeps;
  /** Egress proxy, runner child process, workspace and evidence store for the rerun (Task 17). */
  runTest: RunTestStageDeps;
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
    generateTest: createGenerateTestStage(deps.generateTest), // Task 16
    runTest: createRunTestStage(deps.runTest), // Task 17
    // Fake until Milestone C. INTERIM (Ruling R26, until Task 18): before it runs, Section 2.3's no-rerun
    // rows apply — a PASS/FAIL not backed only by DOM_VERIFIED facts becomes INCONCLUSIVE /
    // UNVERIFIED_EVIDENCE. Each criterion keeps the verifier's status as its `provisional` record.
    // Rerun outcomes are not reconciled until Task 18's `reconcile` (the fake stand-in would call any
    // reached criterion PLAYWRIGHT_RERUN, even when the rerun disagrees — R39's "no fabricated
    // confirmation"): every criterion keeps the no-rerun rows; the rerun's status is still reported.
    report: async (ctx, input) => {
      const provisional = applyNoRerunEvidenceRule(input.provisional, input.exploration?.facts ?? []);
      const report = await fallback.report(ctx, { ...input, provisional, rerun: null });
      const original = new Map(input.provisional.map((p) => [p.criterionId, { status: p.status, reason: p.reason }]));
      return {
        ...report,
        playwright: input.rerun && { status: input.rerun.status, durationMs: input.rerun.durationMs },
        criteria: report.criteria.map((c) => ({ ...c, provisional: original.get(c.criterionId) ?? c.provisional })),
      };
    },
  };
}
