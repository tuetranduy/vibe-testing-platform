import { eq } from "drizzle-orm";
import { CriterionResultSchema, suiteVerdict, isTerminalLifecycle, type TestReport } from "@platform/contracts";
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
  schema,
  type Database,
  type RunScope,
} from "@platform/db";
// The pure assembler only (Ruling R36): this entry point never loads Stagehand, a browser or an LLM client.
import { aggregateVerdict, createReportBuilder, type PersistedRunSources } from "@platform/testing-engine/reporting";
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
      rerunOf: run.request.rerunOf ?? null,
    },
    requirement,
    plan,
    steps,
    facts,
    results,
    generatedTest,
    playwright: playwright && {
      status: playwright.payload.status,
      durationMs: playwright.payload.durationMs,
      perCriterion: playwright.payload.perCriterion, // {} for events persisted before Ruling R43
    },
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

  async review(scope: RunScope, runId: string, criterionId: string, status: "PASS" | "FAIL", actorId: string | null): Promise<TestReport> {
    await new RunRepository(this.deps.db).getRequired(scope, runId);
    await this.deps.db.transaction(async (tx) => {
      // Serialize decisions on different criteria too: the aggregate verdict must include every review.
      const existing = await new RunRepository(tx).getRequired(scope, runId);
      // Suite reviews also serialize on the parent so its verdict stays consistent across child reviews.
      if (existing.suiteRunId) await tx.select().from(schema.suiteRuns).where(eq(schema.suiteRuns.id, existing.suiteRunId)).for("update");
      const [run] = await tx.select().from(schema.testRuns).where(eq(schema.testRuns.id, runId)).for("update");
      if (run?.lifecycle !== "COMPLETED") {
        throw new HttpError(409, "REVIEW_NOT_ALLOWED", "Only completed runs can be reviewed");
      }
      const results = new ResultRepository(tx);
      const all = (await results.listByRun(runId)).map((r) => CriterionResultSchema.parse(r));
      const current = all.find((r) => r.criterionId === criterionId);
      if (!current) throw new HttpError(404, "CRITERION_NOT_FOUND", "This criterion has no result");
      if (current.status !== "INCONCLUSIVE") {
        throw new HttpError(409, "REVIEW_NOT_ALLOWED", "Only inconclusive results can be marked as pass or fail");
      }
      const reviewed = CriterionResultSchema.parse({
        ...current, status, reason: null, verdictSource: "USER_REVIEW",
        review: { originalStatus: current.status, originalReason: current.reason, actorId, reviewedAt: new Date().toISOString() },
      });
      await results.upsert(runId, reviewed);
      const verdict = aggregateVerdict(all.map((r) => r.criterionId === criterionId ? reviewed : r));
      await tx.update(schema.testRuns).set({ verdict, updatedAt: new Date() }).where(eq(schema.testRuns.id, runId));
      if (run.suiteRunId) {
        const children = await tx.select({ lifecycle: schema.testRuns.lifecycle, verdict: schema.testRuns.verdict })
          .from(schema.testRuns).where(eq(schema.testRuns.suiteRunId, run.suiteRunId));
        const suiteResult = suiteVerdict(children);
        if (suiteResult) await tx.update(schema.suiteRuns).set({ verdict: suiteResult }).where(eq(schema.suiteRuns.id, run.suiteRunId));
      }
    });
    return this.get(scope, runId);
  }

  async get(scope: RunScope, runId: string): Promise<TestReport> {
    const run = await new RunRepository(this.deps.db).getRequired(scope, runId);
    if (!isTerminalLifecycle(run.lifecycle)) {
      throw new HttpError(409, "REPORT_NOT_READY", `The report is available once the run ends (it is ${run.lifecycle})`);
    }
    return this.builder.buildReport(runId);
  }
}
