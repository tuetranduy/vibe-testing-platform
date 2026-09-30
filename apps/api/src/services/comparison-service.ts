import type { CriterionStatus, RunChange, RunComparison } from "@platform/contracts";
import { RequirementRepository, ResultRepository, RunRepository, type RunScope, type TestRun } from "@platform/db";
import {
  comparableFromReport,
  compareResults,
  createReportBuilder,
  runChange,
  type ComparableRun,
  type ResultComparison,
} from "@platform/testing-engine/reporting";
import { runScope, type Principal } from "../auth/principal";
import type { ApiDeps } from "../deps";
import { HttpError } from "../errors";
import { loadReportSources } from "./report-service";
import { summaryOf } from "./test-run-service";

/**
 * Comparing a finished run with an earlier run of the same test (V1.2 F2): by default the latest COMPLETED run
 * with its comparison key created before it, visible to the caller; `baselineRunId` picks another one.
 */
export class ComparisonService {
  private readonly runs: RunRepository;
  private readonly builder: ReturnType<typeof createReportBuilder>;

  constructor(private readonly deps: Pick<ApiDeps, "db">) {
    this.runs = new RunRepository(deps.db);
    this.builder = createReportBuilder((runId) => loadReportSources(deps.db, runId));
  }

  private async comparable(runId: string): Promise<ComparableRun> {
    return comparableFromReport(await this.builder.buildReport(runId));
  }

  /** The baseline and the comparison of `run` (COMPLETED); null baseline when there is none. */
  async resultsOf(scope: RunScope, run: TestRun, baselineRunId?: string): Promise<{ baseline: TestRun | null; comparison: ResultComparison }> {
    let baseline: TestRun | null;
    if (baselineRunId) {
      if (baselineRunId === run.id) throw new HttpError(400, "VALIDATION_FAILED", "Compare the run with another run");
      baseline = await this.runs.getRequired(scope, baselineRunId);
      if (baseline.lifecycle !== "COMPLETED") {
        throw new HttpError(409, "BASELINE_NOT_FINISHED", "Compare with a run that completed");
      }
    } else {
      baseline = await this.runs.findPreviousComparable(scope, run);
    }
    const [before, after] = await Promise.all([baseline ? this.comparable(baseline.id) : null, this.comparable(run.id)]);
    return { baseline, comparison: compareResults(before, after) };
  }

  async compare(p: Principal, runId: string, baselineRunId?: string): Promise<RunComparison> {
    const scope = runScope(p);
    const run = await this.runs.getRequired(scope, runId);
    if (run.lifecycle !== "COMPLETED") {
      throw new HttpError(409, "RUN_NOT_FINISHED", `A run can be compared once it has completed (it is ${run.lifecycle})`);
    }
    const [{ baseline, comparison }, history] = await Promise.all([this.resultsOf(scope, run, baselineRunId), this.runs.listComparable(scope, run)]);
    return {
      runId: run.id,
      baseline: baseline ? await summaryOf(this.deps.db, baseline) : null,
      chosenBaseline: baselineRunId !== undefined,
      ...comparison,
      history: history.map((r) => ({ runId: r.id, verdict: r.verdict, createdAt: r.createdAt.toISOString() })),
    };
  }

  /**
   * A light comparison for a suite run's children (no full report): each COMPLETED child against its previous run
   * in `scope`, from the stored results and criteria. Other children get no change.
   */
  async changesOf(scope: RunScope, children: readonly TestRun[]): Promise<Map<string, { change: RunChange; baselineRunId: string | null }>> {
    const out = new Map<string, { change: RunChange; baselineRunId: string | null }>();
    for (const child of children) {
      if (child.lifecycle !== "COMPLETED") continue;
      const baseline = await this.runs.findPreviousComparable(scope, child);
      const [before, after] = await Promise.all([baseline ? this.stored(baseline) : null, this.stored(child)]);
      out.set(child.id, { change: runChange(compareResults(before, after), baseline !== null), baselineRunId: baseline?.id ?? null });
    }
    return out;
  }

  private async stored(run: TestRun): Promise<ComparableRun> {
    const [results, requirement] = await Promise.all([
      new ResultRepository(this.deps.db).listByRun(run.id),
      new RequirementRepository(this.deps.db).findLatest(run.id),
    ]);
    const statements = new Map((requirement?.criteria ?? []).map((c) => [c.id, c.statement]));
    return {
      verdict: run.verdict,
      criteria: results.map((r) => ({
        id: r.criterionId,
        description: statements.get(r.criterionId) ?? r.criterionId,
        critical: "critical" in r ? r.critical !== false : true,
        status: r.status as CriterionStatus,
      })),
      durationMs: null,
      costUsd: null,
    };
  }
}
