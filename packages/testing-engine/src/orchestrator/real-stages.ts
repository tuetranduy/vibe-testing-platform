import type { ProvisionalResult } from "@platform/contracts";
import { createExploreStage, type ExploreStageDeps } from "../exploration/explore-stage";
import { createPlanStage } from "../planner/planner";
import { createAnalyzeStage, type RequirementLlm } from "../requirement/compiler";
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
    // Fake until Task 15. The fake verifier ignores the recorded facts, so its PASS/FAIL would be
    // fabricated evidence (§2.3: no PASS without deterministic evidence) — never let one through.
    verify: (ctx, requirement, plan, exploration) =>
      fallback.verify(ctx, requirement, plan, exploration).map(withoutFabricatedVerdict),
    // R7: no generated test until Milestone C, so the rerun is UNAVAILABLE.
    generateTest: async () => null,
    runTest: (ctx, test) => fallback.runTest(ctx, test),
    report: (ctx, input) => fallback.report(ctx, input), // fake until Milestone C
  };
}

/** Interim guard while verify is fake: a decided status becomes INCONCLUSIVE / FACT_NOT_OBSERVED. */
function withoutFabricatedVerdict(r: ProvisionalResult): ProvisionalResult {
  if (r.status !== "PASS" && r.status !== "FAIL") return r;
  return { ...r, status: "INCONCLUSIVE", reason: "FACT_NOT_OBSERVED", factRefs: [], actual: null };
}
