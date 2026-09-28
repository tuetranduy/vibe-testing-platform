import type { LlmProvider } from "@platform/contracts";
import type { LlmTransport } from "../transport";
import { AnthropicTransport } from "./anthropic";
import { FakeTransport } from "./fake";
import { GeminiTransport } from "./gemini";

export interface TransportConfig {
  provider: LlmProvider;
  /** The provider's API key (from Settings or the environment); unused by `fake`. */
  apiKey?: string;
}

/**
 * The provider adapter for one run's model choice. The reasoning level travels with each request
 * (`LlmTransportRequest.reasoning`), so one transport serves every level.
 */
export function createTransport(config: TransportConfig): LlmTransport {
  switch (config.provider) {
    case "anthropic":
      if (!config.apiKey) throw new Error("An API key is required for the anthropic provider");
      return new AnthropicTransport({ apiKey: config.apiKey });
    case "gemini":
      if (!config.apiKey) throw new Error("An API key is required for the gemini provider");
      return new GeminiTransport({ apiKey: config.apiKey });
    case "fake":
      return new FakeTransport();
  }
}

export { AnthropicTransport, type AnthropicTransportOptions } from "./anthropic";
export { FakeTransport, type FakeReply } from "./fake";
export { GeminiTransport, type GeminiTransportOptions } from "./gemini";
