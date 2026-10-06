import { CheckpointSchema, CriterionIdSchema, InputRefSchema, PlannedStepSchema } from "@platform/contracts";
import { z } from "zod";

export const MAX_PLANNED_STEPS = 50;

/**
 * One step as the model returns it. Every field is required (explicit nulls) so the structured-output
 * schema has no optional keys; step ids (PS-1…n) are assigned by the planner, not the model.
 */
export const PlannerStepOutputSchema = z.object({
  kind: PlannedStepSchema.shape.kind,
  description: z.string().min(3).max(500),
  inputRef: InputRefSchema.nullable(),
  checkpoint: CheckpointSchema.nullable(),
  criterionIds: z.array(CriterionIdSchema),
  destructive: z.boolean(),
});
export type PlannerStepOutput = z.infer<typeof PlannerStepOutputSchema>;

export const MAX_SCENARIOS = 5;

/** One scenario as the model returns it: a title and its steps (it starts from a clean session at the target). */
export const PlannerScenarioOutputSchema = z.object({
  title: z.string().min(1).max(200),
  steps: z.array(PlannerStepOutputSchema).min(1).max(MAX_PLANNED_STEPS),
});
export type PlannerScenarioOutput = z.infer<typeof PlannerScenarioOutputSchema>;

/**
 * What the model returns (V1.1 F9): 1–5 scenarios, plus stop conditions shared by all of them. The stop conditions
 * "may be empty" (the prompt), so a reply without them has none: Flash left them out of an answer and its correction,
 * which errored the run (KI-001).
 */
export const PlannerOutputSchema = z.object({
  scenarios: z.array(PlannerScenarioOutputSchema).min(1).max(MAX_SCENARIOS),
  stopConditions: z.array(z.string().max(300)).max(10).default([]),
});
export type PlannerOutput = z.infer<typeof PlannerOutputSchema>;
