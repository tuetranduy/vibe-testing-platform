/**
 * Report builder (Task 18, Ruling R36): the report is a pure assembly over the run's data.
 *
 * - `reconcileCriteria` / `assembleReport` are pure and shared by both producers of a report: the
 *   worker's GENERATING_REPORT stage (`createReportStage`, over the in-memory stage outputs) and the
 *   API's `buildReport(runId)` (over persisted rows, via a loader the API supplies).
 * - This module (and `@platform/testing-engine/reporting`, which re-exports it) imports only the
 *   contracts and other pure modules, so the API can use it without loading Stagehand or a browser.
 *   The diagnostics model lives in ./diagnostics.ts and reaches the stage only as a port.
 *
 * No PASS without deterministic evidence, on every path: every criterion goes through `reconcile`
 * (Section 2.3) — with rerun UNAVAILABLE when there was no rerun, the criterion was not compiled, or
 * (partial reports) the rerun's per-criterion outcome was never persisted. Diagnostics run only after
 * the statuses, summary and verdict are decided, and can add notes, never statuses (D3, Ruling R37).
 */
import {
  CriterionResultSchema,
  ProvisionalResultSchema,
  TestReportSchema,
  type CriterionResult,
  type ErrorCategory,
  type ExplorationStep,
  type GeneratedTest,
  type NormalizedRequirement,
  type ObservedFact,
  type ProvisionalResult,
  type RerunOutcome,
  type RerunResult,
  type RunLifecycle,
  type RunVerdict,
  type TestPlan,
  type TestReport,
} from "@platform/contracts";
import type { EngineStages, StageContext } from "../orchestrator/stages";
import { reconcile } from "../reconciliation/reconcile";
import { aggregateVerdict } from "../verification/aggregate";
import { clip } from "../verification/normalize";

export type ReportSummary = TestReport["summary"];
export type ReportFinding = TestReport["diagnostics"][number];
export type PlaywrightSummary = NonNullable<TestReport["playwright"]>;

/** One `llm_calls` row, as far as the report's usage totals are concerned. */
export interface LlmUsageRow {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

// ---------------------------------------------------------------------------------------------
// Reconciliation of every criterion (pure)
// ---------------------------------------------------------------------------------------------

export interface ReconcileCriteriaInput {
  requirement: NormalizedRequirement | null;
  plan: TestPlan | null;
  steps: readonly ExplorationStep[];
  facts: readonly ObservedFact[];
  /** Persisted or in-memory results: provisional ones are reconciled, final ones are kept as they are. */
  results: readonly (ProvisionalResult | CriterionResult)[];
  /** null → every criterion's rerun outcome is UNAVAILABLE. */
  rerun: RerunResult | null;
  /** The run redactor, for the rerun's error text (Playwright messages can quote the page). */
  redact?: (text: string) => string;
}

const isFinal = (r: ProvisionalResult | CriterionResult): r is CriterionResult => "rerunOutcome" in r;
const refKey = (r: { key: string; checkpoint: string }) => `${r.key}@${r.checkpoint}`;

/**
 * Every criterion's final result, in the requirement's order (results for criteria it does not list
 * follow in their own order). For each provisional result: its rerun outcome (`rerun.perCriterion`,
 * else UNAVAILABLE), its related steps and evidence, then `reconcile`; a rerun error text is appended
 * to `actual` (redacted, then clipped to the contract's 1000 characters).
 *
 * - relatedStepIds: the exploration steps that recorded the criterion's facts (`fact.stepId`, the
 *   last reading of each key@checkpoint — the one the verifier used) plus the golden-path steps whose
 *   planned step lists the criterion; in step order.
 * - evidenceArtifactIds: the rerun's evidence when the criterion's assertion failed or was not reached
 *   (the rerun keeps trace/screenshot/video only on failure), then the related steps' screenshots.
 */
export function reconcileCriteria(input: ReconcileCriteriaInput): CriterionResult[] {
  const order = new Map((input.requirement?.criteria ?? []).map((c, i) => [c.id, i]));
  const rank = (id: string) => order.get(id) ?? Number.MAX_SAFE_INTEGER;
  const results = [...input.results].sort((a, b) => rank(a.criterionId) - rank(b.criterionId));

  const latestFact = new Map<string, ObservedFact>();
  for (const f of input.facts) latestFact.set(refKey(f), f);
  const steps = [...input.steps].sort((a, b) => a.index - b.index);
  const planned = (input.plan?.scenarios ?? []).flatMap((s) => s.steps);
  const redact = input.redact ?? ((s: string) => s);

  return results.map((r) => {
    if (isFinal(r)) return CriterionResultSchema.parse(r);
    const p = ProvisionalResultSchema.parse(r);
    const outcome: RerunOutcome = input.rerun?.perCriterion[p.criterionId] ?? "UNAVAILABLE";

    const factSteps = new Set(p.factRefs.map((ref) => latestFact.get(refKey(ref))?.stepId).filter((id) => id !== undefined));
    const plannedFor = new Set(planned.filter((s) => s.criterionIds.includes(p.criterionId)).map((s) => s.id));
    const related = steps.filter(
      (s) => factSteps.has(s.id) || (s.onGoldenPath && s.plannedStepId !== null && plannedFor.has(s.plannedStepId)),
    );
    const rerunEvidence = outcome === "ASSERTION_FAILED" || outcome === "NOT_REACHED" ? (input.rerun?.artifactIds ?? []) : [];
    const evidence = [...new Set([...rerunEvidence, ...related.flatMap((s) => s.artifactIds)])];

    const result = reconcile(p, outcome, input.facts, {
      evidenceArtifactIds: evidence,
      relatedStepIds: related.map((s) => s.id),
      aiNote: null,
    });
    const errorText = input.rerun?.errorText[p.criterionId];
    if (!errorText || (outcome !== "ASSERTION_FAILED" && outcome !== "NOT_REACHED")) return result;
    const actual = `${result.actual ?? "Not observed"} | Rerun: ${errorText}`;
    return CriterionResultSchema.parse({ ...result, actual: clip(redact(actual)) });
  });
}

// ---------------------------------------------------------------------------------------------
// Assembly (pure)
// ---------------------------------------------------------------------------------------------

export function summarize(criteria: readonly CriterionResult[]): ReportSummary {
  const count = (s: CriterionResult["status"]) => criteria.filter((c) => c.status === s).length;
  return {
    totalCriteria: criteria.length,
    passed: count("PASS"),
    failed: count("FAIL"),
    blocked: count("BLOCKED"),
    inconclusive: count("INCONCLUSIVE"),
    confirmedByRerun: criteria.filter((c) => c.verdictSource === "PLAYWRIGHT_RERUN").length,
  };
}

export function usageOf(rows: readonly LlmUsageRow[]): TestReport["usage"] {
  const sum = (f: (r: LlmUsageRow) => number) => rows.reduce((n, r) => n + f(r), 0);
  return {
    llmCalls: rows.length,
    inputTokens: sum((r) => r.inputTokens),
    outputTokens: sum((r) => r.outputTokens),
    estimatedCostUsd: Math.round(sum((r) => r.estimatedCostUsd) * 1e6) / 1e6,
  };
}

const isPartial = (lifecycle: RunLifecycle) => lifecycle === "ERRORED" || lifecycle === "CANCELLED";

export interface AssembleReportInput {
  runId: string;
  lifecycle: RunLifecycle;
  /** The persisted verdict (COMPLETED runs); otherwise aggregated (Section 2.4), or null for partial reports. */
  verdict: RunVerdict | null;
  error: { category: ErrorCategory; message: string } | null;
  targetUrl: string;
  requirement: NormalizedRequirement | null;
  /** Final (reconciled) results. */
  criteria: CriterionResult[];
  generatedTest: GeneratedTest | null;
  playwright: PlaywrightSummary | null;
  diagnostics: ReportFinding[];
  llmCalls: readonly LlmUsageRow[];
  startedAt: Date | null;
  finishedAt: Date | null;
}

/** The TestReport, validated with the shared contract. `partial` for ERRORED / CANCELLED runs. */
export function assembleReport(input: AssembleReportInput): TestReport {
  const partial = isPartial(input.lifecycle);
  const verdict = partial ? null : (input.verdict ?? (input.criteria.length > 0 ? aggregateVerdict(input.criteria) : null));
  const { startedAt, finishedAt } = input;
  return TestReportSchema.parse({
    runId: input.runId,
    lifecycle: input.lifecycle,
    verdict,
    error: input.error,
    partial,
    targetUrl: input.targetUrl,
    requirement: input.requirement,
    summary: summarize(input.criteria),
    criteria: input.criteria,
    generatedTest: input.generatedTest && {
      id: input.generatedTest.id,
      source: input.generatedTest.source,
      compiledCriteria: input.generatedTest.compiledCriteria,
      notCompiled: input.generatedTest.notCompiled,
      notes: input.generatedTest.notes,
    },
    playwright: input.playwright,
    diagnostics: input.diagnostics,
    usage: usageOf(input.llmCalls),
    startedAt: startedAt?.toISOString() ?? null,
    finishedAt: finishedAt?.toISOString() ?? null,
    durationMs: startedAt && finishedAt ? finishedAt.getTime() - startedAt.getTime() : null,
  });
}

// ---------------------------------------------------------------------------------------------
// buildReport(runId): the API's report over persisted data
// ---------------------------------------------------------------------------------------------

/** Everything persisted about a run that the report needs (loaded by the API from the database). */
export interface PersistedRunSources {
  run: {
    runId: string;
    lifecycle: RunLifecycle;
    verdict: RunVerdict | null;
    errorCategory: ErrorCategory | null;
    errorMessage: string | null;
    targetUrl: string;
    startedAt: Date | null;
    finishedAt: Date | null;
  };
  requirement: NormalizedRequirement | null;
  plan: TestPlan | null;
  steps: ExplorationStep[];
  facts: ObservedFact[];
  /** `criterion_results` rows: final results, or provisional-only ones when the run ended early. */
  results: (ProvisionalResult | CriterionResult)[];
  generatedTest: GeneratedTest | null;
  /** From the persisted `playwright.completed` event (no column holds it). */
  playwright: PlaywrightSummary | null;
  /** `diagnostic_findings` rows. */
  diagnostics: ReportFinding[];
  /** `llm_calls` rows. */
  llmCalls: LlmUsageRow[];
}

export type ReportSourceLoader = (runId: string) => Promise<PersistedRunSources>;

/**
 * `buildReport(runId)` over a loader. COMPLETED runs: the persisted final results and verdict.
 * ERRORED / CANCELLED: a partial report with whatever exists; provisional-only rows are reconciled with
 * rerun UNAVAILABLE (the per-criterion rerun outcomes are not persisted before the report stage).
 * Tenant scoping and "is the run terminal?" are the caller's (the API route's) checks.
 */
export function createReportBuilder(load: ReportSourceLoader): { buildReport(runId: string): Promise<TestReport> } {
  return {
    async buildReport(runId) {
      const s = await load(runId);
      const criteria = reconcileCriteria({ requirement: s.requirement, plan: s.plan, steps: s.steps, facts: s.facts, results: s.results, rerun: null });
      return assembleReport({
        runId: s.run.runId,
        lifecycle: s.run.lifecycle,
        verdict: s.run.verdict,
        error: s.run.errorCategory ? { category: s.run.errorCategory, message: s.run.errorMessage ?? "" } : null,
        targetUrl: s.run.targetUrl,
        requirement: s.requirement,
        criteria,
        generatedTest: s.generatedTest,
        playwright: s.playwright,
        diagnostics: s.diagnostics,
        llmCalls: s.llmCalls,
        startedAt: s.run.startedAt,
        finishedAt: s.run.finishedAt,
      });
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The GENERATING_REPORT stage (worker)
// ---------------------------------------------------------------------------------------------

/** What the diagnostics model is given: decided results and template material only. */
export interface DiagnosticsInput {
  runId: string;
  signal: AbortSignal;
  deadlineAt: Date | null;
  redact: (value: unknown) => unknown;
  requirement: NormalizedRequirement;
  plan: TestPlan;
  criteria: readonly CriterionResult[];
  summary: ReportSummary;
  verdict: RunVerdict;
  steps: readonly ExplorationStep[];
  facts: readonly ObservedFact[];
  playwright: PlaywrightSummary | null;
}

/** What diagnostics can add: findings and semantic notes. There is no status anywhere in it. */
export interface DiagnosticsResult {
  findings: ReportFinding[];
  notes: { criterionId: string; note: string }[];
}

/** The diagnostics port (./diagnostics.ts `createDiagnostics`). Absent → no diagnostics (Ruling R37). */
export type Diagnostics = (input: DiagnosticsInput) => Promise<DiagnosticsResult>;

/** Persistence port, implemented by the worker (`diagnostic_findings`, `llm_calls`). */
export interface ReportStore {
  saveDiagnostics(findings: ReportFinding[]): Promise<void>;
  /** The run's `llm_calls` rows, read after diagnostics so its own calls are counted. */
  llmUsage(): Promise<LlmUsageRow[]>;
}

export interface ReportStageDeps {
  store(ctx: StageContext): ReportStore;
  /** Ruling R37: on when the real engine has an LLM; tests toggle it by passing / omitting it. */
  diagnostics?: Diagnostics;
  logger?: { warn(obj: object, msg?: string): void };
}

const MAX_FINDING = 2000;
const MAX_NOTE = 1000;

/**
 * The real GENERATING_REPORT stage: reconcile every criterion → summary + verdict → diagnostics
 * (optional; statuses are already decided and cannot change) → persist findings → usage → report.
 * The orchestrator persists the final criterion results and publishes the final `criterion.evaluated`
 * events and `run.completed` (Ruling R34).
 *
 * A diagnostics failure (provider error, invalid output) never fails the run: the report is built
 * without diagnostics and a warning is logged. Cancellation / the hard deadline still end the run.
 */
export function createReportStage(deps: ReportStageDeps): EngineStages["report"] {
  return async (ctx, input) => {
    const steps = input.exploration?.steps ?? [];
    const facts = input.exploration?.facts ?? [];
    const decided = reconcileCriteria({
      requirement: input.requirement,
      plan: input.plan,
      steps,
      facts,
      results: input.provisional,
      rerun: input.rerun,
      redact: (s) => String(ctx.redact(s)),
    });
    const summary = summarize(decided);
    const verdict = aggregateVerdict(decided);
    const playwright = input.rerun && { status: input.rerun.status, durationMs: input.rerun.durationMs };

    let diagnosed: DiagnosticsResult = { findings: [], notes: [] };
    if (deps.diagnostics && needsDiagnostics(input.requirement, decided)) {
      try {
        diagnosed = await deps.diagnostics({
          runId: ctx.runId,
          signal: ctx.signal,
          deadlineAt: ctx.deadlineAt,
          redact: ctx.redact,
          requirement: input.requirement,
          plan: input.plan,
          criteria: decided,
          summary,
          verdict,
          steps,
          facts,
          playwright,
        });
      } catch (err) {
        if (ctx.signal.aborted) throw ctx.signal.reason;
        deps.logger?.warn({ runId: ctx.runId, err: err instanceof Error ? err.message : String(err) }, "report diagnostics failed; reporting without them");
      }
    }

    // Notes go only to semantic criteria, and only as `aiNote`: the status fields are copied untouched.
    const semantic = new Set(input.requirement.criteria.filter((c) => c.expectedOutcome.kind === "semantic").map((c) => c.id));
    const notes = new Map(diagnosed.notes.filter((n) => semantic.has(n.criterionId)).map((n) => [n.criterionId, n.note]));
    const criteria = decided.map((c) => {
      const note = notes.get(c.criterionId);
      return note === undefined ? c : CriterionResultSchema.parse({ ...c, aiNote: clip(String(ctx.redact(note)), MAX_NOTE) });
    });
    const findings = diagnosed.findings.map((f) => ({ criterionId: f.criterionId, summary: clip(String(ctx.redact(f.summary)), MAX_FINDING) }));

    const store = deps.store(ctx);
    if (findings.length > 0) await store.saveDiagnostics(findings);
    const llmCalls = await store.llmUsage();

    return assembleReport({
      runId: ctx.runId,
      lifecycle: "GENERATING_REPORT",
      verdict,
      error: null,
      targetUrl: ctx.request.targetUrl,
      requirement: input.requirement,
      criteria,
      generatedTest: input.generatedTest,
      playwright,
      diagnostics: findings,
      llmCalls,
      startedAt: input.startedAt,
      finishedAt: ctx.now(),
    });
  };
}

/** Something to explain (a criterion that did not pass) or to comment on (a semantic criterion). */
function needsDiagnostics(requirement: NormalizedRequirement, criteria: readonly CriterionResult[]): boolean {
  return criteria.some((c) => c.status !== "PASS") || requirement.criteria.some((c) => c.expectedOutcome.kind === "semantic");
}
