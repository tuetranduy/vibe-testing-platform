import type { ReasoningLevel } from "@platform/contracts";
import type { JsonSchema, LlmMessage } from "./types";

export interface LlmTransportRequest {
  model: string;
  /** May be empty. */
  system: string;
  messages: LlmMessage[];
  /** The response must be a JSON value matching this schema. */
  jsonSchema: JsonSchema;
  schemaName: string;
  maxTokens: number;
  /** `default`: no reasoning parameter (the model's own level). */
  reasoning: ReasoningLevel;
  signal: AbortSignal;
}

export interface LlmTransportResponse {
  /** Raw response text; the client parses and validates it. */
  text: string;
  /**
   * The model that served the request, as reported by the provider (may be a dated snapshot id).
   * Informational: LlmClient prices and records the requested model.
   */
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  /**
   * Set only when a server-side refusal fallback answered (Anthropic `fallbacks`): the model that served the
   * request. LlmClient then prices and records the call under it instead of the requested model.
   */
  fallbackModel?: string;
}

/** A provider adapter: one request, no retries (the client owns retry, abort and deadline policy). */
export interface LlmTransport {
  readonly provider: string;
  complete(request: LlmTransportRequest): Promise<LlmTransportResponse>;
}

/** A provider failure, classified so the client can decide whether to retry. */
export class LlmTransportError extends Error {
  readonly status: number | undefined;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  constructor(message: string, opts: { status?: number; retryable: boolean; retryAfterMs?: number; cause?: unknown }) {
    super(message, { cause: opts.cause });
    this.name = "LlmTransportError";
    this.status = opts.status;
    this.retryable = opts.retryable;
    this.retryAfterMs = opts.retryAfterMs;
  }
}
