import { createAnalyzeStage, type RequirementLlm } from "../requirement/compiler";
import type { EngineStages } from "./stages";

export interface RealStageDeps {
  llm: RequirementLlm;
}

/**
 * The engine used when a real LLM provider is configured (Ruling R7). Each stage is either real or
 * delegated to `fallback` (the fake engine) until its task lands; later tasks swap one line each.
 */
export function createRealStages(deps: RealStageDeps, fallback: EngineStages): EngineStages {
  return {
    analyze: createAnalyzeStage(deps.llm), // Task 10
    plan: (ctx, requirement) => fallback.plan(ctx, requirement), // fake until Task 11
    explore: (ctx, plan, requirement) => fallback.explore(ctx, plan, requirement), // fake until Task 14
    verify: (ctx, requirement, plan, exploration) => fallback.verify(ctx, requirement, plan, exploration), // fake until Task 15
    // R7: no generated test until Milestone C, so the rerun is UNAVAILABLE.
    generateTest: async () => null,
    runTest: (ctx, test) => fallback.runTest(ctx, test),
    report: (ctx, input) => fallback.report(ctx, input), // fake until Milestone C
  };
}
