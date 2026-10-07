import { randomBytes } from "node:crypto";
import { GeneratedTestSchema, type GeneratedTest } from "@platform/contracts";
import type { EngineStages, StageContext } from "../orchestrator/stages";
import { redactedCause, type FailureLogger } from "../shared/log-cause";
import { generatedTestData } from "../shared/generated-inputs";
import { resolveTestDataValues } from "../shared/test-data-values";
import { assertSafeSource } from "./ast-guard";
import { compilePlaywrightTest } from "./test-compiler";

/** Persistence port (Ruling R28), implemented by the worker over `GeneratedTestRepository`. */
export interface GeneratedTestStore {
  save(test: GeneratedTest): Promise<void>;
}

/** Injected dependencies of the real GENERATING_TEST stage. */
export interface GenerateTestStageDeps {
  store(ctx: StageContext): GeneratedTestStore;
  /** Receives the (redacted) cause when the flow cannot be compiled (Ruling R45). */
  logger?: FailureLogger | undefined;
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
 *
 * Ruling R45: a compiler failure (an exception, the guard rejecting the source after redaction)
 * degrades like a rerun failure (R41): its cause is logged (redacted) and the stage returns null, so
 * the criteria reconcile with rerun UNAVAILABLE — an optional confirmation step must not cost the
 * run its verdict. The run's own abort still propagates; persistence failures are infrastructure
 * errors and propagate too.
 */
export function createGenerateTestStage(deps: GenerateTestStageDeps): EngineStages["generateTest"] {
  return async (ctx, input) => {
    let test: GeneratedTest;
    try {
      const compiled = compilePlaywrightTest({
        // A text check's test data key is compiled as the run's value (KI-001), kept in run-data.json like inputs: the
        // value given, else the one a fill generated (2026-10-07).
        requirement: resolveTestDataValues(input.requirement, { ...generatedTestData(input.exploration.steps), ...ctx.request.testData }),
        plan: input.plan,
        steps: input.exploration.steps,
        facts: input.exploration.facts,
        provisional: input.provisional,
        targetUrl: ctx.request.targetUrl,
        secretNames: ctx.request.secretNames,
        testData: ctx.request.testData,
      });
      if (compiled.compiledCriteria.length === 0) return null;
      test = GeneratedTestSchema.parse(ctx.redact({ id: newGeneratedTestId(), ...compiled }));
      assertSafeSource(test.source); // what is persisted (after redaction) must pass the guard too
    } catch (err) {
      if (ctx.signal.aborted) throw ctx.signal.reason;
      deps.logger?.error({ runId: ctx.runId, err: redactedCause(err, ctx.redact) }, "generated test could not be compiled; the run goes on without a rerun");
      return null;
    }
    await deps.store(ctx).save(test);
    return test;
  };
}
