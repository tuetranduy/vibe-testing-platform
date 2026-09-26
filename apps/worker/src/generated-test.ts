import { GeneratedTestRepository, type Database } from "@platform/db";
import type { GenerateTestStageDeps, GeneratedTestStore, StageContext } from "@platform/testing-engine";
import type { WorkerLogger } from "./deps";

/** The GENERATING_TEST stage's persistence port for one run (Ruling R28): the `generated_tests` row. */
export function createGeneratedTestStore(db: Database, ctx: Pick<StageContext, "runId">): GeneratedTestStore {
  const repo = new GeneratedTestRepository(db);
  return {
    async save(test) {
      await repo.save(ctx.runId, test);
    },
  };
}

/** The real generate-test stage's dependencies (Task 16); a compiler failure's cause goes to the worker log (Ruling R45). */
export function createGenerateTestDeps(db: Database, logger?: Pick<WorkerLogger, "error">): GenerateTestStageDeps {
  return { store: (ctx) => createGeneratedTestStore(db, ctx), ...(logger ? { logger } : {}) };
}
