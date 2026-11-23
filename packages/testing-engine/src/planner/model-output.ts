import { CheckpointSchema, CriterionIdSchema, InputRefSchema, MAX_PLAN_STEPS, PlannedStepSchema } from "@platform/contracts";
import { z } from "zod";

/**
 * Steps in one scenario, and in all of them together (post-validate.ts). It was 50 per scenario: a quote flow of
 * about 74 steps could not be planned, and DeepSeek Flash spent its whole output budget reasoning about it
 * (run_0mwsywc5i4ea89000d0fac718).
 */
export const MAX_PLANNED_STEPS = MAX_PLAN_STEPS;

/**
 * A plan of up to 100 steps is about 8,000 tokens of JSON, and a reasoning model's thinking counts against the same
 * budget: at the client's 16,000, DeepSeek Flash spent all of it thinking about a 74-step quote flow and answered
 * nothing (run_0mwsywc5i4ea89000d0fac718). A replan of a long flow is nearly as long (KI-095).
 */
export const PLANNER_MAX_TOKENS = 32_000;
/** 32,000 tokens at DeepSeek Flash's ~200 tokens/s is about 160 s, past the transports' 120 s default. */
export const PLANNER_TIMEOUT_MS = 300_000;

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
