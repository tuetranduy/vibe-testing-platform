import { z } from "zod";
import { IsoDateTime } from "./common";
import { CriterionStatusSchema, RunVerdictSchema, TestRunSummarySchema } from "./run";

/**
 * Comparing a result with an earlier run of the same test (V1.2 F2). Criteria are matched by id when their
 * wording is the same, otherwise by wording alone.
 */
export const CriterionChangeSchema = z.enum(["fixed", "regressed", "changed", "unchanged", "added", "removed"]);
export type CriterionChange = z.infer<typeof CriterionChangeSchema>;

export const CriterionComparisonSchema = z.object({
  /** The criterion's id in this run (in the baseline for a removed one). */
  id: z.string(),
  description: z.string(),
  critical: z.boolean(),
  before: CriterionStatusSchema.nullable(),
  after: CriterionStatusSchema.nullable(),
  change: CriterionChangeSchema,
});
export type CriterionComparison = z.infer<typeof CriterionComparisonSchema>;

const BeforeAfter = <T extends z.ZodType>(t: T) => z.object({ before: t.nullable(), after: t.nullable() });

export const ComparisonCountsSchema = z.object({
  regressed: z.number().int(),
  fixed: z.number().int(),
  changed: z.number().int(),
  unchanged: z.number().int(),
  added: z.number().int(),
  removed: z.number().int(),
});
export type ComparisonCounts = z.infer<typeof ComparisonCountsSchema>;

export const BaselineChoiceSchema = z.object({ runId: z.string(), verdict: RunVerdictSchema.nullable(), createdAt: IsoDateTime });

export const RunComparisonSchema = z.object({
  runId: z.string(),
  /** Null when no earlier run of this test finished: every criterion is `added`. */
  baseline: TestRunSummarySchema.nullable(),
  /** The run was compared with the baseline it asked for, not the previous one. */
  chosenBaseline: z.boolean(),
  verdict: BeforeAfter(RunVerdictSchema),
  criteria: z.array(CriterionComparisonSchema),
  counts: ComparisonCountsSchema,
  durationMs: BeforeAfter(z.number()),
  costUsd: BeforeAfter(z.number()),
  /** Other finished runs of the same test, newest first: the baselines one may choose. */
  history: z.array(BaselineChoiceSchema),
});
export type RunComparison = z.infer<typeof RunComparisonSchema>;

/** How a suite run's test did against its own previous run. */
export const RunChangeSchema = z.enum(["regressed", "fixed", "changed", "unchanged", "new"]);
export type RunChange = z.infer<typeof RunChangeSchema>;
