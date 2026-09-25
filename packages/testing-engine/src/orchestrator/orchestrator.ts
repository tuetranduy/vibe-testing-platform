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
  TestPlan,
  TestReport,
} from "@platform/contracts";
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
}

const STAGE_LABEL: Partial<Record<RunLifecycle, string>> = {
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

/** analyze-run: QUEUED → ANALYZING_REQUIREMENT → AWAITING_CONFIRMATION | PLANNING (+ enqueue execute-run). */
export async function runAnalysis(ctx: StageContext, ports: RunPorts, stages: EngineStages): Promise<void> {
  await ports.transition("ANALYZING_REQUIREMENT", { heartbeatAt: ctx.now() });
  await started(ports, "ANALYZING_REQUIREMENT");
  await ctx.boundary();

  const draft = await stages.analyze(ctx);
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

  if (ctx.request.options.autoConfirmCriteria) {
    const confirmed = await ports.confirmRequirement(requirement.revision);
    await ports.publish({
      type: "criteria.confirmed",
      message: `Criteria revision ${confirmed.revision} confirmed automatically`,
      payload: { revision: confirmed.revision },
    });
    // Enqueuing execute-run resets heartbeatAt so the reaper leaves it alone while it waits.
    await ports.transition("PLANNING", { heartbeatAt: ctx.now() });
    await ports.enqueueExecute();
  } else {
    await ports.transition("AWAITING_CONFIRMATION", { heartbeatAt: null });
  }
}

export interface ExecutionResult {
  verdict: RunVerdict;
  report: TestReport;
}

/** execute-run: PLANNING → … → COMPLETED. Throws on cancel / deadline / infrastructure errors. */
export async function runExecution(ctx: StageContext, ports: RunPorts, stages: EngineStages): Promise<ExecutionResult> {
  const startedAt = ctx.now();
  const requirement = await ports.getConfirmedRequirement();

  // PLANNING
  await started(ports, "PLANNING");
  const plan = await stages.plan(ctx, requirement);
  await ports.savePlan(plan);
  const scenario = plan.scenarios[0]!;
  await ports.publish({
    type: "plan.created",
    message: `Plan created with ${scenario.steps.length} steps`,
    payload: {
      stepCount: scenario.steps.length,
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
    exploration = await stages.explore(ctx, plan, requirement);
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
      generatedTest = await stages.generateTest(ctx, { requirement, plan, exploration, provisional });
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
        rerun = await stages.runTest(ctx, generatedTest);
        await ports.publish({
          type: "playwright.completed",
          message: `Playwright rerun ${rerun.status.toLowerCase()}`,
          payload: { status: rerun.status, durationMs: rerun.durationMs },
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
  const report = await stages.report(ctx, { requirement, plan, exploration, provisional, generatedTest, rerun, startedAt });
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
  await ports.transition("COMPLETED", { verdict });
  await ports.publish({ type: "run.completed", message: `Run completed: ${verdict}`, payload: { verdict } });
  return { verdict, report: { ...report, verdict, lifecycle: "COMPLETED" } };
}
