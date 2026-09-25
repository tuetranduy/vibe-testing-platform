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

/** What the model returns: the single scenario's title and steps, plus stop conditions. */
export const PlannerOutputSchema = z.object({
  title: z.string().min(1).max(200),
  steps: z.array(PlannerStepOutputSchema).min(1).max(MAX_PLANNED_STEPS),
  stopConditions: z.array(z.string().max(300)).max(10),
});
export type PlannerOutput = z.infer<typeof PlannerOutputSchema>;
