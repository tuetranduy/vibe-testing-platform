import { z } from "zod";
import { CheckpointSchema, CriterionIdSchema } from "./common";
import { BlockReasonSchema } from "./run";

export const InputRefSchema = z.object({
  source: z.enum(["testData", "secret", "literal"]),
  key: z.string().min(1).max(200), // testData key, secret name, or the literal value itself
});
export type InputRef = z.infer<typeof InputRefSchema>;

export const PlannedStepSchema = z
  .object({
    id: z.string().regex(/^PS-\d{1,3}$/),
    kind: z.enum([
      "navigate",
      "search",
      "click",
      "fill",
      "select",
      "submit",
      "login",
      "capture_checkpoint",
      "wait_for",
      "other",
    ]),
    description: z.string().min(3).max(500), // natural-language instruction; never contains secret values
    inputRef: InputRefSchema.optional(),
    checkpoint: CheckpointSchema.optional(), // required when kind = capture_checkpoint
    criterionIds: z.array(CriterionIdSchema).default([]),
    destructive: z.boolean().default(false),
  })
  .refine((s) => s.kind !== "capture_checkpoint" || !!s.checkpoint, {
    message: "checkpoint is required when kind = capture_checkpoint",
    path: ["checkpoint"],
  });
export type PlannedStep = z.infer<typeof PlannedStepSchema>;

/** A scenario's id: SC-1 … SC-5 (V1.1 F9, D12 amended). */
export const ScenarioIdSchema = z.string().regex(/^SC-[1-5]$/);
export const MAX_SCENARIOS = 5;
/** Planned steps across every scenario of a plan. */
export const MAX_PLAN_STEPS = 100;

export const TestScenarioSchema = z.object({
  id: ScenarioIdSchema,
  title: z.string().max(200),
  criterionIds: z.array(CriterionIdSchema).min(1),
  steps: z.array(PlannedStepSchema).min(1).max(50),
});
export type TestScenario = z.infer<typeof TestScenarioSchema>;

export const BlockedCriterionSchema = z.object({
  criterionId: CriterionIdSchema,
  reason: BlockReasonSchema,
  detail: z.string().max(500),
});
export type BlockedCriterion = z.infer<typeof BlockedCriterionSchema>;

/**
 * D12 amended (V1.1 F9): 1–5 scenarios. Each starts from a clean browser session at the target URL, so
 * criteria that need different starting states (signed out vs signed in) or would undo each other's
 * preconditions can be checked in one run. Scenario ids are SC-1…n in order, step ids are unique across the
 * plan, and a criterion belongs to one scenario at most.
 */
export const TestPlanSchema = z
  .object({
    runId: z.string(),
    requirementRevision: z.number().int().min(1),
    scenarios: z.array(TestScenarioSchema).min(1).max(MAX_SCENARIOS),
    blockedCriteria: z.array(BlockedCriterionSchema),
    stopConditions: z.array(z.string().max(300)).max(10),
  })
  .superRefine((plan, ctx) => {
    plan.scenarios.forEach((s, i) => {
      if (s.id !== `SC-${i + 1}`) ctx.addIssue({ code: "custom", path: ["scenarios", i, "id"], message: `Scenario ${i + 1} must be SC-${i + 1}` });
    });
    const stepIds = new Set<string>();
    const owner = new Map<string, string>();
    let total = 0;
    plan.scenarios.forEach((s, i) => {
      total += s.steps.length;
      s.steps.forEach((step, j) => {
        if (stepIds.has(step.id)) ctx.addIssue({ code: "custom", path: ["scenarios", i, "steps", j, "id"], message: `Duplicate step id ${step.id}` });
        stepIds.add(step.id);
      });
      s.criterionIds.forEach((id, j) => {
        const other = owner.get(id);
        if (other) ctx.addIssue({ code: "custom", path: ["scenarios", i, "criterionIds", j], message: `${id} is already in ${other}` });
        else owner.set(id, s.id);
      });
    });
    if (total > MAX_PLAN_STEPS) ctx.addIssue({ code: "custom", path: ["scenarios"], message: `At most ${MAX_PLAN_STEPS} steps in all scenarios` });
  });
export type TestPlan = z.infer<typeof TestPlanSchema>;

/** The scenario a criterion belongs to (its id in `criterionIds`), else the first one. */
export function scenarioOfCriterion(plan: Pick<TestPlan, "scenarios">, criterionId: string): TestScenario {
  return plan.scenarios.find((s) => s.criterionIds.includes(criterionId)) ?? plan.scenarios[0]!;
}
