import { z } from "zod";
import { CriterionIdSchema, DataKeySchema } from "./common";
import { SurveyedPageSchema } from "./suggestions";

/**
 * Requirement analysis against the live website (V1.3). While the requirement is analyzed, the worker reads
 * the start page and a few pages it links to (read-only, like the survey: nothing is clicked, typed or
 * submitted), and the compile call sees what they show. The result is advisory — it never changes a status:
 *
 * - `checks`: per criterion, whether what it checks was seen on the pages read;
 * - `testData`: values for the test data keys the criteria need but the run was not given — taken from the
 *   site (a product name it lists) or generated (a synthetic email) — which the user accepts, edits or drops
 *   when confirming the criteria (applied automatically with `autoConfirmCriteria`). Never secrets.
 */

export const SiteCheckStatusSchema = z.enum(["FOUND", "NOT_FOUND", "UNCLEAR"]);
export type SiteCheckStatus = z.infer<typeof SiteCheckStatusSchema>;

export const SiteCheckSchema = z.object({
  criterionId: CriterionIdSchema,
  status: SiteCheckStatusSchema,
  /** What was (not) seen, and where: e.g. "The Products page has an Add to cart button". */
  note: z.string().max(300),
});
export type SiteCheck = z.infer<typeof SiteCheckSchema>;

/** A suggested test data value is never null: a key with nothing to suggest is left out. */
export const SuggestedTestDataValueSchema = z.union([z.string().min(1).max(2000), z.number(), z.boolean()]);

export const TestDataSuggestionSchema = z.object({
  key: DataKeySchema,
  value: SuggestedTestDataValueSchema,
  /** What the value is for, e.g. "Email address to register with". */
  description: z.string().max(300),
  /** SITE: taken from what the live site shows; GENERATED: synthetic (the model's, or the platform's generator). */
  source: z.enum(["SITE", "GENERATED"]),
});
export type TestDataSuggestion = z.infer<typeof TestDataSuggestionSchema>;

export const MAX_TEST_DATA_SUGGESTIONS = 20;

/** What a model is shown of one page read: its structure, never an input's value (the survey's inventory script). */
export const PageInventorySchema = z.object({
  title: z.string().max(200),
  description: z.string().max(300),
  headings: z.array(z.object({ level: z.union([z.literal(1), z.literal(2), z.literal(3)]), text: z.string().max(150) })).max(40),
  links: z.array(z.object({ text: z.string().max(100), url: z.string().max(2048), area: z.enum(["nav", "main"]) })).max(60),
  forms: z
    .array(
      z.object({
        name: z.string().max(80),
        fields: z.array(z.object({ label: z.string().max(80), type: z.string().max(20), placeholder: z.string().max(80) })).max(20),
        submit: z.string().max(60),
      }),
    )
    .max(10),
  buttons: z.array(z.string().max(60)).max(40),
});
export type PageInventory = z.infer<typeof PageInventorySchema>;

/** A page read for the analysis: where it landed (origin + path) and what it showed. */
export const SitePageSchema = z.object({ url: z.string().max(2048), inventory: PageInventorySchema });
export type SitePage = z.infer<typeof SitePageSchema>;

export const SiteAnalysisSchema = z.object({
  /**
   * READ: at least the start page was read; UNAVAILABLE: reading it failed (`reason` says why) and the
   * criteria were compiled from the requirement alone; SKIPPED: the run turned it off (`analyzeLiveSite`).
   */
  status: z.enum(["READ", "UNAVAILABLE", "SKIPPED"]),
  reason: z.string().max(300).nullable(),
  /** The pages tried, in order (origin + path, never the query). */
  pages: z.array(SurveyedPageSchema).max(6),
  checks: z.array(SiteCheckSchema).max(20),
  testData: z.array(TestDataSuggestionSchema).max(MAX_TEST_DATA_SUGGESTIONS),
  /** The suggested keys that became the run's test data (at confirmation, or automatically). */
  appliedKeys: z.array(DataKeySchema).max(MAX_TEST_DATA_SUGGESTIONS).default([]),
  /**
   * What the pages read showed (redacted, capped), kept for the planner: it plans the way to each control from
   * them (KI-048). Empty in an analysis stored before they were kept.
   */
  pageContents: z.array(SitePageSchema).max(6).default([]),
});
export type SiteAnalysis = z.infer<typeof SiteAnalysisSchema>;
export type SiteAnalysisDraft = z.input<typeof SiteAnalysisSchema>;

/**
 * `POST /v1/test-runs/:runId/criteria/confirm` body (V1.3, optional): test data to add to the run before it
 * starts — typically the accepted suggestions, possibly edited. A key the run already has is replaced.
 */
export const ConfirmCriteriaRequestSchema = z.object({
  testData: z
    .record(DataKeySchema, SuggestedTestDataValueSchema)
    .refine((o) => Object.keys(o).length <= MAX_TEST_DATA_SUGGESTIONS, `At most ${MAX_TEST_DATA_SUGGESTIONS} test data values`)
    .default({}),
});
export type ConfirmCriteriaRequestInput = z.input<typeof ConfirmCriteriaRequestSchema>;
export type ConfirmCriteriaRequest = z.output<typeof ConfirmCriteriaRequestSchema>;
