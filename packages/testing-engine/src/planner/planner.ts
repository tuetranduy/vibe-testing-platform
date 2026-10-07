import { ContractError, TestPlanSchema, type NormalizedRequirement, type StoredTestRunRequest, type TestPlan } from "@platform/contracts";
import type { ActionPolicy } from "@platform/security";
import { requireLlm, type StageContext } from "../orchestrator/stages";
import type { RequirementLlm } from "../requirement/compiler";
import { applyBlocking } from "./blocking";
import { PlannerOutputSchema } from "./model-output";
import { validatePlanOutput } from "./post-validate";
import { PLANNER_SYSTEM_PROMPT, buildPlannerPrompt } from "./prompts";
import { actionPolicyFor } from "../shared/action-policy";

export { actionPolicyFor };

export interface PlanTestInput {
  runId: string;
  /** The confirmed requirement (criteria are frozen). */
  requirement: NormalizedRequirement;
  targetUrl: string;
  /** Names only: values never reach the planner. */
  testDataKeys: string[];
  secretNames: string[];
  /** Credentials taken from the requirement text (V1.3.1): names only. */
  inlineInputs?: StoredTestRunRequest["inlineInputs"];
  policy: ActionPolicy;
  signal: AbortSignal;
  deadlineAt?: Date | null;
  /** The run redactor (masks secret values). */
  redact: (value: unknown) => unknown;
}

/**
 * Confirmed requirement → TestPlan of 1–5 scenarios (V1.1 F9). The model proposes the scenarios and their
 * steps; our code assigns ids and criteria, checks the contract (one correction round, then ContractError)
 * and decides blocking and truncation deterministically, per scenario (blocking.ts). The orchestrator
 * persists the plan and publishes `plan.created`.
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
          inlineInputs: input.inlineInputs,
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

  // Blocking and truncation are per scenario: each starts from a clean session, so a step in one never
  // blocks a criterion of another. A fallback step (a scenario cut entirely) gets a plan-unique id.
  let fallback = validated.scenarios.reduce((n, s) => n + s.steps.length, 0);
  const blockedCriteria: TestPlan["blockedCriteria"] = [];
  const scenarios = validated.scenarios.map((s, i) => {
    const blocking = applyBlocking({
      criteria: requirement.criteria.filter((c) => s.criterionIds.includes(c.id)),
      steps: s.steps,
      targetUrl: input.targetUrl,
      policy: input.policy,
      fallbackStepId: validated.scenarios.length === 1 ? "PS-1" : `PS-${++fallback}`,
    });
    blockedCriteria.push(...blocking.blockedCriteria);
    return { id: `SC-${i + 1}`, title: s.title, criterionIds: s.criterionIds, steps: blocking.steps };
  });
  const plan: TestPlan = {
    runId: input.runId,
    requirementRevision: requirement.revision,
    scenarios,
    blockedCriteria,
    stopConditions: data.stopConditions,
  };
  // The model never sees secret values, but a requirement may quote one: redact by value before the
  // plan is persisted, then re-check the shape.
  const parsed = TestPlanSchema.safeParse(input.redact(plan));
  if (!parsed.success) throw new ContractError(`Planned scenario is invalid after redaction: ${parsed.error.message}`);
  return parsed.data;
}

/** The real `plan` stage: plans with the run's model client, names, action policy, redactor and deadline. */
export function createPlanStage(): (ctx: StageContext, requirement: NormalizedRequirement) => Promise<TestPlan> {
  return async (ctx, requirement) =>
    planTest(requireLlm(ctx), {
      runId: ctx.runId,
      requirement,
      targetUrl: ctx.request.targetUrl,
      testDataKeys: Object.keys(ctx.request.testData),
      secretNames: ctx.secrets.names,
      inlineInputs: ctx.request.inlineInputs,
      policy: actionPolicyFor(ctx.request),
      signal: ctx.signal,
      deadlineAt: ctx.deadlineAt,
      redact: ctx.redact,
    });
}
