import { ContractError, TestPlanSchema, type NormalizedRequirement, type StoredTestRunRequest, type TestPlan } from "@platform/contracts";
import type { ActionPolicy } from "@platform/security";
import type { StageContext } from "../orchestrator/stages";
import type { RequirementLlm } from "../requirement/compiler";
import { applyBlocking } from "./blocking";
import { PlannerOutputSchema } from "./model-output";
import { validatePlanOutput } from "./post-validate";
import { PLANNER_SYSTEM_PROMPT, buildPlannerPrompt } from "./prompts";

export interface PlanTestInput {
  runId: string;
  /** The confirmed requirement (criteria are frozen). */
  requirement: NormalizedRequirement;
  targetUrl: string;
  /** Names only: values never reach the planner. */
  testDataKeys: string[];
  secretNames: string[];
  policy: ActionPolicy;
  signal: AbortSignal;
  deadlineAt?: Date | null;
  /** The run redactor (masks secret values). */
  redact: (value: unknown) => unknown;
}

/** D9: destructive actions only when the run allows them, and never in production. */
export function actionPolicyFor(request: StoredTestRunRequest): ActionPolicy {
  return { allowDestructive: request.options.allowDestructiveActions && request.environment !== "production" };
}

/**
 * Confirmed requirement → one-scenario TestPlan. The model proposes the steps; our code assigns ids,
 * checks the contract (one correction round, then ContractError) and decides blocking and truncation
 * deterministically (blocking.ts). The orchestrator persists the plan and publishes `plan.created`.
 */
export async function planTest(llm: RequirementLlm, input: PlanTestInput): Promise<TestPlan> {
  const { requirement } = input;
  const { data } = await llm.generateStructured({
    schema: PlannerOutputSchema,
    schemaName: "test_plan",
    system: PLANNER_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: buildPlannerPrompt({
          targetUrl: input.targetUrl,
          requirement,
          testDataKeys: input.testDataKeys,
          secretNames: input.secretNames,
        }),
      },
    ],
    check: (output) => {
      const result = validatePlanOutput(output, requirement);
      return result.ok ? [] : result.issues;
    },
    stage: "PLANNING",
    runId: input.runId,
    signal: input.signal,
    deadlineAt: input.deadlineAt ?? null,
    redact: input.redact,
  });
  const validated = validatePlanOutput(data, requirement);
  // Unreachable in practice (`check` already passed), but never hand an invalid plan on.
  if (!validated.ok) throw new ContractError(`Planned scenario is invalid: ${validated.issues.join("; ")}`);

  const { steps, blockedCriteria } = applyBlocking({
    criteria: requirement.criteria,
    steps: validated.steps,
    targetUrl: input.targetUrl,
    testDataKeys: input.testDataKeys,
    secretNames: input.secretNames,
    policy: input.policy,
  });
  const plan: TestPlan = {
    runId: input.runId,
    requirementRevision: requirement.revision,
    scenarios: [{ id: "SC-1", title: data.title, criterionIds: requirement.criteria.map((c) => c.id), steps }],
    blockedCriteria,
    stopConditions: data.stopConditions,
  };
  // The model never sees secret values, but a requirement may quote one: redact by value before the
  // plan is persisted, then re-check the shape.
  const parsed = TestPlanSchema.safeParse(input.redact(plan));
  if (!parsed.success) throw new ContractError(`Planned scenario is invalid after redaction: ${parsed.error.message}`);
  return parsed.data;
}

/** The real `plan` stage: plans with the run's names, action policy, redactor and deadline. */
export function createPlanStage(llm: RequirementLlm): (ctx: StageContext, requirement: NormalizedRequirement) => Promise<TestPlan> {
  return (ctx, requirement) =>
    planTest(llm, {
      runId: ctx.runId,
      requirement,
      targetUrl: ctx.request.targetUrl,
      testDataKeys: Object.keys(ctx.request.testData),
      secretNames: ctx.secrets.names,
      policy: actionPolicyFor(ctx.request),
      signal: ctx.signal,
      deadlineAt: ctx.deadlineAt,
      redact: ctx.redact,
    });
}
