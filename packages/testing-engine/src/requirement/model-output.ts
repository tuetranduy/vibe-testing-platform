import { AcceptanceCriterionSchema, FactRequestSchema } from "@platform/contracts";
import { z } from "zod";

/**
 * What the model returns. Criterion ids are assigned by the compiler (AC-1, AC-2, … in order),
 * so the model cannot produce duplicates or gaps.
 *
 * `siteChecks` and `testData` (V1.3) are advisory and deliberately loose: `requirement/insights.ts` keeps
 * what is valid of them and never asks for a correction because of them. Defaulted, so an answer without
 * them (a model that ignores them, a scripted test answer) still parses.
 */
export const CompilerOutputSchema = z.object({
  title: z.string().trim().min(3).max(120).nullable().default(null),
  /**
   * What the user wants to test (2026-11-11), deliberately loose like the advisory fields: `requirement/intent.ts`
   * clips it to the contract. Null (a model that ignores it, a scripted answer) is read as a specific requirement.
   */
  intent: z
    .object({ clarity: z.enum(["specific", "feature", "vague", "site_wide"]), goal: z.string(), feature: z.string().nullable().default(null) })
    .nullable()
    .default(null),
  // `critical` is the user's call in review (V1.1), never the model's: it is not in the output schema.
  criteria: z.array(AcceptanceCriterionSchema.omit({ id: true, critical: true })).min(1).max(20),
  facts: z.array(FactRequestSchema).max(60),
  siteChecks: z
    .array(z.object({ criterion: z.number(), status: z.enum(["found", "not_found", "unclear"]), note: z.string() }))
    .default([]),
  testData: z
    .array(z.object({ key: z.string(), value: z.union([z.string(), z.number(), z.boolean()]), description: z.string(), fromSite: z.boolean() }))
    .default([]),
});
export type CompilerOutput = z.infer<typeof CompilerOutputSchema>;
