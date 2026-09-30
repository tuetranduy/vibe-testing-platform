import type {
  CancelReason,
  ErrorCategory,
  ExplorationOutcome,
  GeneratedTest,
  NormalizedRequirement,
  ProvisionalResult,
  RerunResult,
  RunLifecycle,
  RunVerdict,
  SuggestionSet,
  SuggestionSetDraft,
  TestPlan,
  TestReport,
} from "@platform/contracts";
import { rerunOnlyResults } from "../reporting/rerun-only";
import { aggregateVerdict } from "../verification/aggregate";
import type { EngineStages, EventDraft, RequirementDraft, StageContext } from "./stages";

export interface TransitionPatch {
  verdict?: RunVerdict;
  errorCategory?: ErrorCategory;
  errorMessage?: string;
  cancelReason?: CancelReason;
  heartbeatAt?: Date | null;
}

/** Persistence + lifecycle side effects, implemented by the worker. */
export interface RunPorts {
  /** CAS transition from the port's tracked lifecycle. */
  transition(to: RunLifecycle, patch?: TransitionPatch): Promise<void>;
  lifecycle(): RunLifecycle;
  publish(event: EventDraft): Promise<void>;
  saveRequirement(draft: RequirementDraft): Promise<NormalizedRequirement>;
  confirmRequirement(revision: number): Promise<NormalizedRequirement>;
  getConfirmedRequirement(): Promise<NormalizedRequirement>;
  savePlan(plan: TestPlan): Promise<void>;
  saveResults(results: ProvisionalResult[]): Promise<void>;
  enqueueExecute(): Promise<void>;
  /** A manual rerun's copy of its source run's generated test (V1.1 F5). */
  getGeneratedTest(): Promise<GeneratedTest>;
  /** Stores the survey's suggestions for the run (nothing selected yet). */
  saveSuggestions(draft: SuggestionSetDraft): Promise<SuggestionSet>;
}

/**
 * Races a stage against the run signal so a stage that ignores cancellation or the hard deadline
 * can't keep the run alive (Section 2.7). The abandoned stage's resources are released by the
 * worker's cleanup hooks.
 */
export function guard<T>(ctx: StageContext, work: Promise<T>): Promise<T> {
  const { signal } = ctx;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

const STAGE_LABEL: Partial<Record<RunLifecycle, string>> = {
  SURVEYING: "Exploring for test ideas",
  ANALYZING_REQUIREMENT: "Analyzing requirement",
  PLANNING: "Planning test",
  EXPLORING: "Exploring website",
  VERIFYING: "Verifying criteria",
  GENERATING_TEST: "Generating Playwright test",
  RUNNING_PLAYWRIGHT: "Rerunning generated test",
  GENERATING_REPORT: "Generating report",
};

async function started(ports: RunPorts, stage: RunLifecycle) {
  await ports.publish({ type: "stage.started", message: `${STAGE_LABEL[stage]} started`, payload: { stage } });
}
async function completed(ports: RunPorts, stage: RunLifecycle) {
  await ports.publish({ type: "stage.completed", message: `${STAGE_LABEL[stage]} completed`, payload: { stage } });
}
async function skipped(ports: RunPorts, stage: RunLifecycle) {
  await ports.publish({ type: "stage.skipped", message: `${STAGE_LABEL[stage]} skipped`, payload: { stage } });
}

/**
 * analyze-run: QUEUED → ANALYZING_REQUIREMENT → AWAITING_CONFIRMATION | PLANNING (+ enqueue execute-run).
 * After a selection the API has already moved the run to ANALYZING_REQUIREMENT (heartbeat reset),
 * so the analysis starts from there.
 */
export async function runAnalysis(ctx: StageContext, ports: RunPorts, stages: EngineStages): Promise<void> {
  if (ports.lifecycle() !== "ANALYZING_REQUIREMENT") await ports.transition("ANALYZING_REQUIREMENT", { heartbeatAt: ctx.now() });
  await started(ports, "ANALYZING_REQUIREMENT");
  await ctx.boundary();

  const draft = await guard(ctx, stages.analyze(ctx));
  await ctx.boundary();
  const requirement = await ports.saveRequirement(draft);
  const n = requirement.criteria.length;
  await ports.publish({
    type: "criteria.proposed",
    message: `${n} acceptance ${n === 1 ? "criterion" : "criteria"} identified`,
    payload: {
      revision: requirement.revision,
      criteria: requirement.criteria.map((c) => ({ id: c.id, statement: c.statement, ambiguous: c.ambiguity !== null })),
    },
  });
  await completed(ports, "ANALYZING_REQUIREMENT");
  await ctx.boundary();

  if (ctx.request.options.autoConfirmCriteria) {
    const confirmed = await ports.confirmRequirement(requirement.revision);
    await ports.publish({
      type: "criteria.confirmed",
      message: `Criteria revision ${confirmed.revision} confirmed automatically`,
      payload: { revision: confirmed.revision },
    });
    await ctx.boundary();
    // Enqueuing execute-run resets heartbeatAt so the reaper leaves it alone while it waits.
    await ports.transition("PLANNING", { heartbeatAt: ctx.now() });
    await ports.enqueueExecute();
  } else {
    await ports.transition("AWAITING_CONFIRMATION", { heartbeatAt: null });
  }
}

/**
 * analyze-run for a blank requirement: QUEUED → SURVEYING → AWAITING_SELECTION. The survey stage
 * reads the website and proposes tests; the set is stored and announced (ids and titles only), and
 * the run waits — held by nobody, like AWAITING_CONFIRMATION — for the user to choose one. A blank
 * requirement always waits for the user: autoConfirmCriteria applies to the chosen test's criteria.
 */
export async function runSurvey(ctx: StageContext, ports: RunPorts, stages: EngineStages): Promise<void> {
  await ports.transition("SURVEYING", { heartbeatAt: ctx.now() });
  await started(ports, "SURVEYING");
  await ctx.boundary();

  const draft = await guard(ctx, stages.survey(ctx));
  await ctx.boundary();
  const set = await ports.saveSuggestions(draft);
  const n = set.suggestions.length;
  await ports.publish({
    type: "suggestions.proposed",
    message: `${n} ${n === 1 ? "test" : "tests"} suggested`,
    payload: { count: n, suggestions: set.suggestions.map((s) => ({ id: s.id, title: s.title })) },
  });
  await completed(ports, "SURVEYING");
  await ctx.boundary();
  await ports.transition("AWAITING_SELECTION", { heartbeatAt: null });
}

export interface ExecutionResult {
  verdict: RunVerdict;
  report: TestReport;
}

/** execute-run: PLANNING → … → COMPLETED. Throws on cancel / deadline / infrastructure errors. */
export async function runExecution(ctx: StageContext, ports: RunPorts, stages: EngineStages): Promise<ExecutionResult> {
  const startedAt = ctx.now();
  await ctx.boundary();
  const requirement = await ports.getConfirmedRequirement();

  // PLANNING
  await started(ports, "PLANNING");
  const plan = await guard(ctx, stages.plan(ctx, requirement));
  await ports.savePlan(plan);
  const stepCount = plan.scenarios.reduce((n, s) => n + s.steps.length, 0);
  const scenarios = plan.scenarios.length;
  await ports.publish({
    type: "plan.created",
    message: `Plan created with ${stepCount} steps${scenarios > 1 ? ` in ${scenarios} scenarios` : ""}`,
    payload: {
      stepCount,
      blockedCriteria: plan.blockedCriteria.map((b) => ({ criterionId: b.criterionId, reason: b.reason })),
    },
  });
  await completed(ports, "PLANNING");
  await ctx.boundary();

  const blocked = new Set(plan.blockedCriteria.map((b) => b.criterionId));
  const allBlocked = requirement.criteria.every((c) => blocked.has(c.id));

  let exploration: ExplorationOutcome | null = null;
  let provisional: ProvisionalResult[];
  let generatedTest: GeneratedTest | null = null;
  let rerun: RerunResult | null = null;

  if (allBlocked) {
    await ports.transition("GENERATING_REPORT");
    for (const s of ["EXPLORING", "VERIFYING", "GENERATING_TEST", "RUNNING_PLAYWRIGHT"] as const) await skipped(ports, s);
    provisional = stages.verify(ctx, requirement, plan, null);
    await ports.saveResults(provisional);
  } else {
    // EXPLORING
    await ports.transition("EXPLORING");
    await started(ports, "EXPLORING");
    exploration = await guard(ctx, stages.explore(ctx, plan, requirement));
    await completed(ports, "EXPLORING");
    await ctx.boundary();

    // VERIFYING
    await ports.transition("VERIFYING");
    await started(ports, "VERIFYING");
    provisional = stages.verify(ctx, requirement, plan, exploration);
    await ports.saveResults(provisional);
    for (const r of provisional) {
      await ports.publish({
        type: "criterion.evaluated",
        message: `${r.criterionId} provisionally ${r.status}`,
        payload: { criterionId: r.criterionId, status: r.status, reason: r.reason, provisional: true },
      });
    }
    await completed(ports, "VERIFYING");
    await ctx.boundary();

    const compilable = provisional.some((r) => r.status === "PASS" || r.status === "FAIL");
    if (ctx.request.options.generatePlaywright && compilable) {
      await ports.transition("GENERATING_TEST");
      await started(ports, "GENERATING_TEST");
      generatedTest = await guard(ctx, stages.generateTest(ctx, { requirement, plan, exploration, provisional }));
      if (generatedTest) {
        await ports.publish({
          type: "test.generated",
          message: `Playwright test generated for ${generatedTest.compiledCriteria.length} criteria`,
          payload: { compiledCriteria: generatedTest.compiledCriteria, notCompiled: generatedTest.notCompiled },
        });
      }
      await completed(ports, "GENERATING_TEST");
      await ctx.boundary();

      if (ctx.request.options.rerunGeneratedTest && generatedTest) {
        await ports.transition("RUNNING_PLAYWRIGHT");
        await started(ports, "RUNNING_PLAYWRIGHT");
        rerun = await guard(ctx, stages.runTest(ctx, generatedTest));
        await ports.publish({
          type: "playwright.completed",
          message: `Playwright rerun ${rerun.status.toLowerCase()}`,
          // perCriterion (ids + outcomes) lets a partial report reconcile against the rerun (Ruling R43).
          payload: { status: rerun.status, durationMs: rerun.durationMs, perCriterion: rerun.perCriterion },
        });
        await completed(ports, "RUNNING_PLAYWRIGHT");
        await ctx.boundary();
      } else {
        await skipped(ports, "RUNNING_PLAYWRIGHT");
      }
    } else {
      await skipped(ports, "GENERATING_TEST");
      await skipped(ports, "RUNNING_PLAYWRIGHT");
    }
    await ports.transition("GENERATING_REPORT");
  }

  // GENERATING_REPORT
  await started(ports, "GENERATING_REPORT");
  const report = await guard(
    ctx,
    stages.report(ctx, { requirement, plan, exploration, provisional, generatedTest, rerun, startedAt }),
  );
  await ports.saveResults(report.criteria);
  for (const r of report.criteria) {
    await ports.publish({
      type: "criterion.evaluated",
      message: `${r.criterionId} ${r.status}`,
      payload: { criterionId: r.criterionId, status: r.status, reason: r.reason, provisional: false },
    });
  }
  const verdict = aggregateVerdict(report.criteria);
  await completed(ports, "GENERATING_REPORT");
  await ctx.boundary(); // the hard deadline applies up to the very end
  await ports.transition("COMPLETED", { verdict });
  await ports.publish({ type: "run.completed", message: `Run completed: ${verdict}`, payload: { verdict } });
  return { verdict, report: { ...report, verdict, lifecycle: "COMPLETED" } };
}

/**
 * rerun-run (V1.1 F5): a manual rerun of a saved Playwright test. QUEUED → RUNNING_PLAYWRIGHT →
 * GENERATING_REPORT → COMPLETED, with no exploration and no model call; the stages before the rerun are
 * published as skipped. Statuses come from the rerun alone (rerunOnlyResults). A rerun that fails on its own
 * is reported, not thrown (Ruling R41); cancel, the hard deadline and infrastructure errors still throw.
 */
export async function runRerunOnly(ctx: StageContext, ports: RunPorts, stages: EngineStages): Promise<ExecutionResult["verdict"]> {
  await ctx.boundary();
  const [requirement, test] = await Promise.all([ports.getConfirmedRequirement(), ports.getGeneratedTest()]);

  await ports.transition("RUNNING_PLAYWRIGHT", { heartbeatAt: ctx.now() });
  for (const s of ["ANALYZING_REQUIREMENT", "PLANNING", "EXPLORING", "VERIFYING", "GENERATING_TEST"] as const) await skipped(ports, s);
  await started(ports, "RUNNING_PLAYWRIGHT");
  const rerun = await guard(ctx, stages.runTest(ctx, test));
  await ports.publish({
    type: "playwright.completed",
    message: `Playwright rerun ${rerun.status.toLowerCase()}`,
    payload: { status: rerun.status, durationMs: rerun.durationMs, perCriterion: rerun.perCriterion },
  });
  await completed(ports, "RUNNING_PLAYWRIGHT");
  await ctx.boundary();

  await ports.transition("GENERATING_REPORT");
  await started(ports, "GENERATING_REPORT");
  const results = rerunOnlyResults(requirement, test, rerun);
  await ports.saveResults(results);
  for (const r of results) {
    await ports.publish({
      type: "criterion.evaluated",
      message: `${r.criterionId} ${r.status}`,
      payload: { criterionId: r.criterionId, status: r.status, reason: r.reason, provisional: false },
    });
  }
  const verdict = aggregateVerdict(results);
  await completed(ports, "GENERATING_REPORT");
  await ctx.boundary();
  await ports.transition("COMPLETED", { verdict });
  await ports.publish({ type: "run.completed", message: `Run completed: ${verdict}`, payload: { verdict } });
  return verdict;
}
