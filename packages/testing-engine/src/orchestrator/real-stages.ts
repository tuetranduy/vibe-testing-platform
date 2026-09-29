import { createGenerateTestStage, type GenerateTestStageDeps } from "../compiler/generate-stage";
import { createExploreStage, type ExploreStageDeps } from "../exploration/explore-stage";
import { createRunTestStage, type RunTestStageDeps } from "../playwright-runner/run-stage";
import { createPlanStage } from "../planner/planner";
import { createReportStage, type ReportStageDeps } from "../reporting/report-builder";
import { createAnalyzeStage } from "../requirement/compiler";
import { verifyStage } from "../verification/verify-stage";
import type { EngineStages } from "./stages";

/** The model client is not a dependency: every real stage uses the run's own (`StageContext.llm`, requireLlm). */
export interface RealStageDeps {
  /** Browser sandbox, explorer and persistence for the explore stage (Task 14). */
  exploration: ExploreStageDeps;
  /** Persistence for the generated test (Task 16, Ruling R28). */
  generateTest: GenerateTestStageDeps;
  /** Egress proxy, runner child process, workspace and evidence store for the rerun (Task 17). */
  runTest: RunTestStageDeps;
  /** Findings / usage persistence and the optional diagnostics model for the report (Task 18, R37). */
  report: ReportStageDeps;
}

/**
 * The engine used when a real LLM provider is configured (Ruling R7): every stage is real since
 * Task 18. (LLM_PROVIDER=fake keeps the full fake engine instead.)
 */
export function createRealStages(deps: RealStageDeps): EngineStages {
  return {
    analyze: createAnalyzeStage(), // Task 10
    plan: createPlanStage(), // Task 12
    explore: createExploreStage(deps.exploration), // Task 14
    verify: verifyStage, // Task 15
    generateTest: createGenerateTestStage(deps.generateTest), // Task 16
    runTest: createRunTestStage(deps.runTest), // Task 17
    report: createReportStage(deps.report), // Task 18: reconciliation (R35 replaces the interim R26 rule)
  };
}
