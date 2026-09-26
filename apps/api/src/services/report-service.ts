import { isTerminalLifecycle, type TestReport } from "@platform/contracts";
import {
  DiagnosticFindingRepository,
  EventRepository,
  ExplorationStepRepository,
  GeneratedTestRepository,
  LlmCallRepository,
  ObservedFactRepository,
  PlanRepository,
  RequirementRepository,
  ResultRepository,
  RunRepository,
  type Database,
} from "@platform/db";
// The pure assembler only (Ruling R36): this entry point never loads Stagehand, a browser or an LLM client.
import { createReportBuilder, type PersistedRunSources } from "@platform/testing-engine/reporting";
import type { ApiDeps } from "../deps";
import { HttpError } from "../errors";

/** Everything persisted about a run that its report needs. */
export async function loadReportSources(db: Database, runId: string): Promise<PersistedRunSources> {
  const run = await new RunRepository(db).getById(runId);
  const [requirement, plan, steps, facts, results, generatedTest, playwright, diagnostics, llmCalls] = await Promise.all([
    new RequirementRepository(db).findLatest(runId),
    new PlanRepository(db).find(runId),
    new ExplorationStepRepository(db).listByRun(runId),
    new ObservedFactRepository(db).listByRun(runId),
    new ResultRepository(db).listByRun(runId),
    new GeneratedTestRepository(db).findByRun(runId),
    new EventRepository(db).findLastOfType(runId, "playwright.completed"),
    new DiagnosticFindingRepository(db).listByRun(runId),
    new LlmCallRepository(db).listByRun(runId),
  ]);
  return {
    run: {
      runId: run.id,
      lifecycle: run.lifecycle,
      verdict: run.verdict,
      errorCategory: run.errorCategory,
      errorMessage: run.errorMessage,
      targetUrl: run.targetUrl,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    },
    requirement,
    plan,
    steps,
    facts,
    results,
    generatedTest,
    playwright: playwright && { status: playwright.payload.status, durationMs: playwright.payload.durationMs },
    diagnostics,
    llmCalls,
  };
}

/**
 * GET /v1/test-runs/:runId/report (Task 18). Tenant-scoped (other tenants' runs are 404), only for
 * terminal runs (409 otherwise): COMPLETED → the full report; ERRORED / CANCELLED → partial.
 */
export class ReportService {
  private readonly builder: ReturnType<typeof createReportBuilder>;

  constructor(private readonly deps: Pick<ApiDeps, "db" | "config">) {
    this.builder = createReportBuilder((runId) => loadReportSources(deps.db, runId));
  }

  async get(runId: string): Promise<TestReport> {
    const run = await new RunRepository(this.deps.db).getRequired(this.deps.config.defaultTenantId, runId);
    if (!isTerminalLifecycle(run.lifecycle)) {
      throw new HttpError(409, "REPORT_NOT_READY", `The report is available once the run ends (it is ${run.lifecycle})`);
    }
    return this.builder.buildReport(runId);
  }
}
