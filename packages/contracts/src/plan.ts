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

export const TestScenarioSchema = z.object({
  id: z.literal("SC-1"),
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

export const TestPlanSchema = z.object({
  runId: z.string(),
  requirementRevision: z.number().int().min(1),
  scenarios: z.array(TestScenarioSchema).length(1), // D12
  blockedCriteria: z.array(BlockedCriterionSchema),
  stopConditions: z.array(z.string().max(300)).max(10),
});
export type TestPlan = z.infer<typeof TestPlanSchema>;
