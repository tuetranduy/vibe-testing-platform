import { z } from "zod";
import { IsoDateTime } from "./common";

/** Model providers. `fake` is the deterministic fake engine (never in production). */
export const LlmProviderSchema = z.enum(["anthropic", "gemini", "fake"]);
export type LlmProvider = z.infer<typeof LlmProviderSchema>;

/** The providers that take an API key (Settings → AI providers). */
export const LlmKeyProviderSchema = z.enum(["anthropic", "gemini"]);
export type LlmKeyProvider = z.infer<typeof LlmKeyProviderSchema>;

/** `default` sends no reasoning parameter: the model's own level (what every run did before). */
export const ReasoningLevelSchema = z.enum(["default", "minimal", "low", "medium", "high"]);
export type ReasoningLevel = z.infer<typeof ReasoningLevelSchema>;

/** The model a run uses, as it records it (`StoredTestRunRequest.llm`). */
export const LlmChoiceSchema = z.object({
  provider: LlmProviderSchema,
  model: z.string().min(1).max(100),
  reasoning: ReasoningLevelSchema,
});
export type LlmChoice = z.infer<typeof LlmChoiceSchema>;

/**
 * A new run's model override (`CreateTestRunRequest.llm`): shape only. The API checks the catalog and the
 * provider's key when it resolves the run's choice.
 */
export const LlmOverrideSchema = z.object({
  model: z.string().min(1).max(100).optional(),
  reasoning: ReasoningLevelSchema.optional(),
});
export type LlmOverride = z.infer<typeof LlmOverrideSchema>;

/** Settings → Defaults for new tests. */
export const LlmDefaultsInputSchema = z.object({
  model: z.string().min(1).max(100),
  reasoning: ReasoningLevelSchema,
});
export type LlmDefaultsInput = z.infer<typeof LlmDefaultsInputSchema>;

/** `PUT /v1/settings/llm` body. */
export const UpdateLlmSettingsRequestSchema = z.object({ defaults: LlmDefaultsInputSchema });
export type UpdateLlmSettingsRequest = z.infer<typeof UpdateLlmSettingsRequestSchema>;

/**
 * `PUT /v1/settings/llm/keys/:provider` body. `null` removes the saved key. A key is trimmed, 1–500 characters,
 * printable ASCII without spaces (the rule loadEnv applies to environment keys). No message quotes the value.
 */
export const ProviderKeyInputSchema = z.object({
  apiKey: z
    .string()
    .trim()
    .min(1, "Enter the API key")
    .max(500, "An API key has at most 500 characters")
    .regex(/^[\x21-\x7e]+$/, "An API key is one line of printable ASCII characters without spaces")
    .nullable(),
});
export type ProviderKeyInput = z.infer<typeof ProviderKeyInputSchema>;

const SettingSourceSchema = z.enum(["settings", "environment"]);

/** `GET /v1/settings/llm` (and the answer of every settings `PUT`). Never contains a key. */
export const LlmSettingsViewSchema = z.object({
  defaults: z.object({
    provider: LlmProviderSchema,
    model: z.string(),
    label: z.string(),
    reasoning: ReasoningLevelSchema,
    source: SettingSourceSchema,
    /** False when new runs on these defaults would be refused (e.g. their provider's key was removed). */
    available: z.boolean(),
  }),
  providers: z.array(
    z.object({
      provider: LlmKeyProviderSchema,
      label: z.string(),
      key: z.object({ source: SettingSourceSchema.nullable(), updatedAt: IsoDateTime.nullable() }),
    }),
  ),
  models: z.array(
    z.object({
      provider: LlmProviderSchema,
      id: z.string(),
      label: z.string(),
      /** Always starts with "default". */
      reasoningLevels: z.array(ReasoningLevelSchema),
      /** What "default" means, for display; null: the model does not reason. */
      defaultLevel: z.enum(["minimal", "low", "medium", "high"]).nullable(),
      /** Today's list price (USD per million tokens); null when unknown. */
      price: z.object({ inputUsdPerMTok: z.number(), outputUsdPerMTok: z.number() }).nullable(),
      /** Its provider has a key (the fake engine: offered in this deployment). */
      available: z.boolean(),
    }),
  ),
});
export type LlmSettingsView = z.infer<typeof LlmSettingsViewSchema>;
