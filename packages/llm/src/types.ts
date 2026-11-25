import type { RunLifecycle } from "@platform/contracts";

/** A JSON Schema object (draft 2020-12 subset); providers may constrain it further. */
export type JsonSchema = Record<string, unknown>;

export type LlmContentPart =
  | { type: "text"; text: string }
  /** `data` is base64 without a data: prefix. */
  | { type: "image"; data: string; mimeType: string };

export interface LlmMessage {
  role: "user" | "assistant";
  content: string | LlmContentPart[];
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export type LlmCallStatus = "SUCCESS" | "INVALID_OUTPUT" | "PROVIDER_ERROR" | "CANCELLED";

/**
 * One request as sent (after the run redactor) and its answer: what the admin run logs show (2026-11-25). Image
 * parts keep their type and size only.
 */
export interface LlmExchangeRecord {
  system: string;
  messages: LlmMessage[];
  /** The provider's text; null when the request failed. */
  response: string | null;
  /** The provider error's message for PROVIDER_ERROR / CANCELLED; null otherwise. */
  error: string | null;
}

/** One provider request (one row in `llm_calls`, its exchange in `llm_call_exchanges`). */
export interface LlmCallRecord {
  runId: string;
  stage: RunLifecycle;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  latencyMs: number;
  status: LlmCallStatus;
  /** Why the call was made: the request's schema name (e.g. "Observation"); null when the caller named none. */
  purpose: string | null;
  exchange: LlmExchangeRecord;
}

/** Where call records go (the worker wires this to the database). */
export type LlmCallSink = (call: LlmCallRecord) => void | Promise<void>;
