import { z } from "zod";
import { CriterionIdSchema, FactRefSchema } from "./common";
import { ExplorationStepSchema, ObservedFactSchema } from "./exploration";
import { BlockReasonSchema, CriterionStatusSchema, InconclusiveReasonSchema } from "./run";

/** AI_JUDGMENT (2026-10-07): an unclear (`semantic`) criterion judged by a model from what the exploration saw. */
export const VerdictSourceSchema = z.enum(["PLAYWRIGHT_RERUN", "EXPLORATION_ONLY", "AI_JUDGMENT"]);
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
  /** The status is a model's judgment of what the exploration saw (2026-10-07; `semantic` criteria only). */
  aiJudged: z.boolean().optional(),
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
  aiNote: z.string().max(1000).nullable(), // semantic criteria: the model's reasoning or comment; the status comes from the judgment step
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
  /** Each scenario's own stop reason (V1.1 F9); absent on outcomes before V1.1 (one scenario: `stopReason`). */
  scenarioStops: z.record(z.string(), ExplorationStopReasonSchema).optional(),
  /** The exploration's own recordings — video and scrubbed trace (V1.3) — as artifact ids; run-wide evidence. */
  artifactIds: z.array(z.string()).optional(),
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
