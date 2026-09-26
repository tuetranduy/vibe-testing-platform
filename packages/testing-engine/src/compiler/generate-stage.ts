import { randomBytes } from "node:crypto";
import { GeneratedTestSchema, type GeneratedTest } from "@platform/contracts";
import type { EngineStages, StageContext } from "../orchestrator/stages";
import { assertSafeSource } from "./ast-guard";
import { compilePlaywrightTest } from "./test-compiler";

/** Persistence port (Ruling R28), implemented by the worker over `GeneratedTestRepository`. */
export interface GeneratedTestStore {
  save(test: GeneratedTest): Promise<void>;
}

/** Injected dependencies of the real GENERATING_TEST stage. */
export interface GenerateTestStageDeps {
  store(ctx: StageContext): GeneratedTestStore;
}

export function newGeneratedTestId(): string {
  return `gt_${Date.now().toString(36)}${randomBytes(6).toString("hex")}`;
}

/**
 * The real GENERATING_TEST stage (Task 16): compiles the discovered flow with the run's test data
 * and secret names (Ruling R29; secret values never reach the compiler), assigns the id, passes the
 * whole test through the run's redactor (exploration rows are already redacted; this is defense in
 * depth for everything persisted, Global Constraints) and persists it. It does not publish
 * `test.generated`: `runExecution` does once the stage returns (Ruling R34).
 *
 * No criterion compiled → null: there is nothing to rerun, and every criterion keeps its
 * rerun outcome UNAVAILABLE.
 */
export function createGenerateTestStage(deps: GenerateTestStageDeps): EngineStages["generateTest"] {
  return async (ctx, input) => {
    const compiled = compilePlaywrightTest({
      requirement: input.requirement,
      plan: input.plan,
      steps: input.exploration.steps,
      facts: input.exploration.facts,
      provisional: input.provisional,
      targetUrl: ctx.request.targetUrl,
      secretNames: ctx.request.secretNames,
      testData: ctx.request.testData,
    });
    if (compiled.compiledCriteria.length === 0) return null;
    const test = GeneratedTestSchema.parse(ctx.redact({ id: newGeneratedTestId(), ...compiled }));
    assertSafeSource(test.source); // what is persisted (after redaction) must pass the guard too
    await deps.store(ctx).save(test);
    return test;
  };
}
