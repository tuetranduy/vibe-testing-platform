import { LlmChoiceSchema, LlmProviderSchema, ReasoningLevelSchema, type LlmChoice } from "@platform/contracts";
import { defaultLlmModel } from "./env";

/** The LLM_* variables resolveEnvLlmChoice reads: a loaded Env, or loadLiveLlmEnv's result. */
export interface EnvLlmSettings {
  LLM_PROVIDER: string;
  LLM_MODEL?: string;
  LLM_REASONING?: string;
  GEMINI_THINKING_LEVEL?: string;
}

/**
 * The model choice the environment configures: what a new run uses when neither its request nor the
 * saved Settings name a model, and what runs created before model choice existed use. The API (run
 * creation) and the worker (runs without a recorded choice) both call it, so they agree. LLM_MODEL unset
 * or empty: the provider's default model; the fake engine's model is always `fake`. Reasoning:
 * LLM_REASONING, else GEMINI_THINKING_LEVEL for gemini, otherwise `default`. Throws for a provider not built in V1
 * (LLM_PROVIDER=openai), which stops the API and the worker at start-up.
 */
export function resolveEnvLlmChoice(env: EnvLlmSettings): LlmChoice {
  const provider = LlmProviderSchema.safeParse(env.LLM_PROVIDER);
  if (!provider.success) {
    throw new Error(`LLM_PROVIDER=${env.LLM_PROVIDER} is not implemented in V1 (use anthropic, gemini, deepseek or fake)`);
  }
  if (provider.data === "fake") return { provider: "fake", model: "fake", reasoning: "default" };
  const level = env.LLM_REASONING || (provider.data === "gemini" ? env.GEMINI_THINKING_LEVEL : undefined);
  const reasoning = level ? ReasoningLevelSchema.parse(level) : "default";
  return LlmChoiceSchema.parse({ provider: provider.data, model: env.LLM_MODEL || defaultLlmModel(provider.data), reasoning });
}
