import { z } from "zod";

/**
 * What the model returns for `test_suggestions`. Deliberately loose (no lengths, no name rules):
 * post-validation checks each suggestion on its own, so one bad suggestion never costs the others,
 * and ids are ours (S-1…), never the model's.
 */
export const SurveyOutputSchema = z.object({
  suggestions: z.array(
    z.object({
      title: z.string(),
      requirement: z.string(),
      why: z.string(),
      needs: z.object({ secrets: z.array(z.string()), testData: z.array(z.string()) }),
      destructive: z.boolean(),
    }),
  ),
});
export type SurveyOutput = z.infer<typeof SurveyOutputSchema>;
