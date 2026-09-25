import { AcceptanceCriterionSchema, FactRequestSchema } from "@platform/contracts";
import { z } from "zod";

/**
 * What the model returns. Criterion ids are assigned by the compiler (AC-1, AC-2, … in order),
 * so the model cannot produce duplicates or gaps.
 */
export const CompilerOutputSchema = z.object({
  criteria: z.array(AcceptanceCriterionSchema.omit({ id: true })).min(1).max(20),
  facts: z.array(FactRequestSchema).max(60),
});
export type CompilerOutput = z.infer<typeof CompilerOutputSchema>;
