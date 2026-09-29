import { z } from "zod";
import { DataKeySchema, HttpUrlSchema, SecretNameSchema } from "./common";

/**
 * Suggested tests (spec 2026-09-28-suggest-tests): with a blank requirement the run surveys the
 * website and proposes 3–8 tests; the user picks one, which becomes the run's requirement.
 */

export const SuggestionIdSchema = z.string().regex(/^S-[1-8]$/);
export type SuggestionId = z.infer<typeof SuggestionIdSchema>;

export const SuggestionSchema = z.object({
  /** Assigned by the platform (S-1…), never by the model. */
  id: SuggestionIdSchema,
  title: z.string().min(3).max(80),
  /** The test as a requirement: what the run analyses when it is chosen. */
  requirement: z.string().min(10).max(1000),
  why: z.string().max(300),
  /** Names only: the secrets and test data keys the test needs. */
  needs: z.object({
    secrets: z.array(SecretNameSchema).max(5),
    testData: z.array(DataKeySchema).max(10),
  }),
  /** It creates, changes or deletes data (or pays, orders, …): blocked unless the run allows it. */
  destructive: z.boolean(),
});
export type Suggestion = z.infer<typeof SuggestionSchema>;

export const SurveyedPageSchema = z.object({
  /** origin + path: never the query string (it can carry personal data). */
  url: HttpUrlSchema,
  title: z.string().max(200),
  status: z.enum(["READ", "SKIPPED"]),
});
export type SurveyedPage = z.infer<typeof SurveyedPageSchema>;

const SelectedSchema = z.object({ suggestionId: SuggestionIdSchema, edited: z.boolean() });

const setFields = {
  suggestions: z.array(SuggestionSchema).min(1).max(8),
  /** The start page and the (at most 5) linked pages the survey tried, in order. */
  pages: z.array(SurveyedPageSchema).max(6),
};

/** Unique ids; a selection names one of the set's suggestions. */
function setIssues(set: { suggestions: { id: string }[]; selected?: { suggestionId: string } | null }) {
  const issues: { path: (string | number)[]; message: string }[] = [];
  const ids = new Set<string>();
  set.suggestions.forEach((s, i) => {
    if (ids.has(s.id)) issues.push({ path: ["suggestions", i, "id"], message: `Duplicate suggestion id ${s.id}` });
    ids.add(s.id);
  });
  if (set.selected && !ids.has(set.selected.suggestionId)) {
    issues.push({ path: ["selected", "suggestionId"], message: `${set.selected.suggestionId} is not one of the suggestions` });
  }
  return issues;
}

/** What the survey stage returns (nothing is selected yet). */
export const SuggestionSetDraftSchema = z.object(setFields).superRefine((set, ctx) => {
  for (const issue of setIssues(set)) ctx.addIssue({ code: "custom", ...issue });
});
export type SuggestionSetDraft = z.infer<typeof SuggestionSetDraftSchema>;

const SuggestionSetObject = z.object({ ...setFields, selected: SelectedSchema.nullable() });

/** What `run_suggestions` stores. */
export const SuggestionSetSchema = SuggestionSetObject.superRefine((set, ctx) => {
  for (const issue of setIssues(set)) ctx.addIssue({ code: "custom", ...issue });
});
export type SuggestionSet = z.infer<typeof SuggestionSetSchema>;

/** `GET /v1/test-runs/:runId/suggestions`: the set, plus what the run has so the UI can mark unmet needs. */
export const SuggestionSetResponseSchema = SuggestionSetObject.extend({
  run: z.object({
    secretNames: z.array(z.string()),
    testDataKeys: z.array(z.string()),
    destructiveActionsAllowed: z.boolean(),
  }),
}).superRefine((set, ctx) => {
  for (const issue of setIssues(set)) ctx.addIssue({ code: "custom", ...issue });
});
export type SuggestionSetResponse = z.infer<typeof SuggestionSetResponseSchema>;

/** `POST /v1/test-runs/:runId/suggestions/select`: `requirement` only when the user edited the text. */
export const SelectSuggestionRequestSchema = z.object({
  suggestionId: SuggestionIdSchema,
  requirement: z
    .string()
    .trim()
    .min(10, "Describe the test in at least 10 characters")
    .max(20_000, "Keep the test under 20,000 characters")
    .optional(),
});
export type SelectSuggestionRequest = z.input<typeof SelectSuggestionRequestSchema>;
export type SelectSuggestion = z.output<typeof SelectSuggestionRequestSchema>;
