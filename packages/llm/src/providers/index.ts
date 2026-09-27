import type { LlmTransport } from "../transport";
import { AnthropicTransport } from "./anthropic";
import { FakeTransport } from "./fake";
import { GeminiTransport, type GeminiThinkingLevel } from "./gemini";

export type LlmProviderName = "fake" | "anthropic" | "gemini" | "openai";

export interface TransportConfig {
  provider: LlmProviderName;
  anthropicApiKey?: string;
  geminiApiKey?: string;
  /** Unset: the Gemini model's default thinking level. */
  geminiThinkingLevel?: GeminiThinkingLevel;
}

/** Build the provider adapter selected by LLM_PROVIDER. Fails fast for providers not built in V1. */
export function createTransport(config: TransportConfig): LlmTransport {
  switch (config.provider) {
    case "anthropic":
      if (!config.anthropicApiKey) throw new Error("ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic");
      return new AnthropicTransport({ apiKey: config.anthropicApiKey });
    case "gemini":
      if (!config.geminiApiKey) throw new Error("GEMINI_API_KEY is required when LLM_PROVIDER=gemini");
      return new GeminiTransport({ apiKey: config.geminiApiKey, thinkingLevel: config.geminiThinkingLevel });
    case "openai":
      throw new Error("LLM_PROVIDER=openai is not implemented in V1 (use anthropic, gemini or fake)");
    case "fake":
      return new FakeTransport();
  }
}

export { AnthropicTransport, type AnthropicTransportOptions } from "./anthropic";
export { FakeTransport, type FakeReply } from "./fake";
export { GeminiTransport, type GeminiThinkingLevel, type GeminiTransportOptions } from "./gemini";
