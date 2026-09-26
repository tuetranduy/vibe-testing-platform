import { DiagnosticFindingRepository, LlmCallRepository, type Database } from "@platform/db";
import { createDiagnostics, type DiagnosticsLlm, type ReportStageDeps, type ReportStore, type StageContext } from "@platform/testing-engine";
import type { WorkerLogger } from "./deps";

/** The GENERATING_REPORT stage's persistence port for one run: `diagnostic_findings` rows and `llm_calls` usage. */
export function createReportStore(db: Database, ctx: Pick<StageContext, "runId">): ReportStore {
  return {
    saveDiagnostics: (findings) => new DiagnosticFindingRepository(db).insertMany(ctx.runId, findings),
    llmUsage: () => new LlmCallRepository(db).listByRun(ctx.runId),
  };
}

/**
 * The real report stage's dependencies (Task 18). Ruling R37: the real engine always has an LLM, so
 * diagnostics are on; they only add notes (statuses are decided first) and a failure only logs a warning.
 */
export function createReportDeps(deps: { db: Database; logger: WorkerLogger; llm: DiagnosticsLlm }): ReportStageDeps {
  return {
    store: (ctx) => createReportStore(deps.db, ctx),
    diagnostics: createDiagnostics(deps.llm),
    logger: deps.logger,
  };
}
