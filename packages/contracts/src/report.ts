import { z } from "zod";
import { CriterionIdSchema, IsoDateTime } from "./common";
import { NormalizedRequirementSchema } from "./requirement";
import { GeneratedInputSchema } from "./exploration";
import { CriterionResultSchema, NotCompiledSchema } from "./results";
import { ErrorCategorySchema, RunLifecycleSchema, RunVerdictSchema } from "./run";

export const TestReportSchema = z.object({
  runId: z.string(),
  lifecycle: RunLifecycleSchema,
  verdict: RunVerdictSchema.nullable(),
  error: z.object({ category: ErrorCategorySchema, message: z.string() }).nullable(),
  partial: z.boolean(), // true for ERRORED / CANCELLED
  /** A manual rerun's source run (V1.1 F5); null for every other run. */
  rerunOf: z.string().nullable().default(null),
  targetUrl: z.string(),
  requirement: NormalizedRequirementSchema.nullable(),
  summary: z.object({
    totalCriteria: z.number().int(),
    passed: z.number().int(),
    failed: z.number().int(),
    blocked: z.number().int(),
    inconclusive: z.number().int(),
    confirmedByRerun: z.number().int(),
    /** V1.1: non-critical criteria, and how many of them did not pass (they never change the verdict). */
    nonCritical: z.object({ total: z.number().int(), notPassed: z.number().int() }).default({ total: 0, notPassed: 0 }),
  }),
  criteria: z.array(CriterionResultSchema),
  generatedTest: z
    .object({
      id: z.string(),
      source: z.string(),
      compiledCriteria: z.array(CriterionIdSchema),
      notCompiled: z.array(NotCompiledSchema),
      notes: z.array(z.string()),
    })
    .nullable(),
  playwright: z
    .object({ status: z.enum(["PASSED", "FAILED", "ERRORED"]), durationMs: z.number().int() })
    .nullable(),
  diagnostics: z.array(z.object({ criterionId: CriterionIdSchema.nullable(), summary: z.string().max(2000) })),
  /** Values nobody provided that exploration generated and filled (2026-10-07). */
  generatedInputs: z.array(GeneratedInputSchema).default([]),
  usage: z.object({
    llmCalls: z.number().int(),
    inputTokens: z.number().int(),
    outputTokens: z.number().int(),
    estimatedCostUsd: z.number(),
  }),
  startedAt: IsoDateTime.nullable(),
  finishedAt: IsoDateTime.nullable(),
  durationMs: z.number().int().nullable(),
});
export type TestReport = z.infer<typeof TestReportSchema>;
