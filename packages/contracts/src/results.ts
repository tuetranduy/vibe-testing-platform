import { z } from "zod";
import { CriterionIdSchema, FactRefSchema } from "./common";
import { ExplorationStepSchema, ObservedFactSchema } from "./exploration";
import { BlockReasonSchema, CriterionStatusSchema, InconclusiveReasonSchema } from "./run";

export const VerdictSourceSchema = z.enum(["PLAYWRIGHT_RERUN", "EXPLORATION_ONLY"]);
export type VerdictSource = z.infer<typeof VerdictSourceSchema>;

export const StatusReasonSchema = z.union([BlockReasonSchema, InconclusiveReasonSchema]);
export type StatusReason = z.infer<typeof StatusReasonSchema>;

export const ProvisionalResultSchema = z.object({
  criterionId: CriterionIdSchema,
  status: CriterionStatusSchema,
  reason: StatusReasonSchema.nullable(),
  factRefs: z.array(FactRefSchema),
  expected: z.string().max(1000), // human-readable, template-built
  actual: z.string().max(1000).nullable(),
});
export type ProvisionalResult = z.infer<typeof ProvisionalResultSchema>;

export const RerunOutcomeSchema = z.enum(["PASSED", "ASSERTION_FAILED", "NOT_REACHED", "UNAVAILABLE"]);
export type RerunOutcome = z.infer<typeof RerunOutcomeSchema>;

export const CriterionResultSchema = ProvisionalResultSchema.extend({
  verdictSource: VerdictSourceSchema.nullable(), // non-null only for PASS/FAIL
  rerunOutcome: RerunOutcomeSchema,
  provisional: ProvisionalResultSchema.pick({ status: true, reason: true }),
  evidenceArtifactIds: z.array(z.string()),
  relatedStepIds: z.array(z.string()),
  aiNote: z.string().max(1000).nullable(), // semantic judge note (D3); never affects status
  /** From the criterion (V1.1): a non-critical result never changes the run's verdict. Rows before V1.1: true. */
  critical: z.boolean().default(true),
}).refine((r) => (r.status === "PASS" || r.status === "FAIL") === (r.verdictSource !== null), {
  message: "verdictSource must be set exactly for PASS/FAIL",
  path: ["verdictSource"],
});
export type CriterionResult = z.infer<typeof CriterionResultSchema>;

export const ArtifactTypeSchema = z.enum(["SCREENSHOT", "TRACE", "VIDEO", "GENERATED_TEST", "PLAYWRIGHT_REPORT"]);
export type ArtifactType = z.infer<typeof ArtifactTypeSchema>;
export const ArtifactSensitivitySchema = z.enum(["STANDARD", "SECRET_BEARING"]);
export type ArtifactSensitivity = z.infer<typeof ArtifactSensitivitySchema>;

export const ExplorationStopReasonSchema = z.enum([
  "COMPLETED",
  "STEP_LIMIT_REACHED",
  "EXPLORATION_BUDGET_EXHAUSTED",
  "BLOCKED_BY_POLICY",
]);
export type ExplorationStopReason = z.infer<typeof ExplorationStopReasonSchema>;

export const ExplorationOutcomeSchema = z.object({
  steps: z.array(ExplorationStepSchema),
  facts: z.array(ObservedFactSchema),
  stopReason: ExplorationStopReasonSchema,
});
export type ExplorationOutcome = z.infer<typeof ExplorationOutcomeSchema>;

export const NotCompiledSchema = z.object({ criterionId: CriterionIdSchema, reason: z.string() });

export const GeneratedTestSchema = z.object({
  id: z.string(),
  source: z.string(),
  helpersSource: z.string(),
  dataJson: z.string(),
  compiledCriteria: z.array(CriterionIdSchema),
  notCompiled: z.array(NotCompiledSchema),
  notes: z.array(z.string()), // e.g. brittle-locator warnings
});
export type GeneratedTest = z.infer<typeof GeneratedTestSchema>;

export const RerunResultSchema = z.object({
  status: z.enum(["PASSED", "FAILED", "ERRORED"]),
  perCriterion: z.record(CriterionIdSchema, RerunOutcomeSchema),
  durationMs: z.number().int(),
  errorText: z.record(CriterionIdSchema, z.string()).default({}),
  /** Ids of the uploaded rerun evidence (trace, screenshot, video), for reconciliation (Ruling R27). */
  artifactIds: z.array(z.string()).default([]),
});
export type RerunResult = z.infer<typeof RerunResultSchema>;
