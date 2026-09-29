import { ContractError, type Suggestion } from "@platform/contracts";
import type { LlmClient, LlmContentPart } from "@platform/llm";
import type { PageInventory } from "./inventory";
import { SurveyOutputSchema } from "./model-output";
import { postValidateSuggestions } from "./post-validate";
import { SURVEY_SYSTEM_PROMPT, buildSurveyPrompt } from "./prompts";

/** The slice of LlmClient the survey needs (the run's client: requireLlm(ctx)). */
export type SurveyLlm = Pick<LlmClient, "generateStructured">;

export interface SuggestTestsInput {
  runId: string;
  startUrl: string;
  environment: "staging" | "production";
  /** destructiveActionsAllowed(request): the effective policy, production's host confirmation included. */
  destructiveAllowed: boolean;
  /** Names only; values never reach the model. */
  testDataKeys: string[];
  secretNames: string[];
  pages: { url: string; inventory: PageInventory }[];
  /** The start page's screenshot (PNG), shown as an image; null when there is none. */
  screenshot: Buffer | null;
  signal: AbortSignal;
  deadlineAt?: Date | null;
  /** The run redactor (masks secret values); the client applies it to every request too. */
  redact: (value: unknown) => unknown;
}

/**
 * The survey's one structured model call (spec section 5, step 5): `stage: "SURVEYING"`, schema
 * `test_suggestions`, at the client's reasoning level (the run's). One correction round, as the
 * compiler and planner: the first answer must be fully valid; the corrected one only needs a valid
 * suggestion, and what is valid is kept. No valid suggestion → ContractError (run ERRORED / CONTRACT).
 */
export async function suggestTests(llm: SurveyLlm, input: SuggestTestsInput): Promise<Suggestion[]> {
  const content: LlmContentPart[] = [
    {
      type: "text",
      text: buildSurveyPrompt({
        startUrl: input.startUrl,
        environment: input.environment,
        destructiveAllowed: input.destructiveAllowed,
        testDataKeys: input.testDataKeys,
        secretNames: input.secretNames,
        pages: input.redact(input.pages) as SuggestTestsInput["pages"],
        hasScreenshot: input.screenshot !== null,
      }),
    },
  ];
  if (input.screenshot) content.push({ type: "image", data: input.screenshot.toString("base64"), mimeType: "image/png" });

  const { data } = await llm.generateStructured({
    schema: SurveyOutputSchema,
    schemaName: "test_suggestions",
    system: SURVEY_SYSTEM_PROMPT,
    messages: [{ role: "user", content }],
    check: (output, { corrected }) => {
      const result = postValidateSuggestions(output);
      if (!corrected) return result.issues;
      if (result.suggestions.length > 0) return [];
      return result.issues.length > 0 ? result.issues : ["suggestions: at least one valid test is required"];
    },
    stage: "SURVEYING",
    runId: input.runId,
    signal: input.signal,
    deadlineAt: input.deadlineAt ?? null,
    redact: input.redact,
  });
  const { suggestions, issues } = postValidateSuggestions(data);
  // Unreachable in practice (`check` passed), but never hand an empty set on.
  if (suggestions.length === 0) throw new ContractError(`No valid test suggestion: ${issues.slice(0, 5).join("; ")}`);
  return suggestions;
}
