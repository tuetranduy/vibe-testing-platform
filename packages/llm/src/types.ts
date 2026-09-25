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

/** One provider request (one row in `llm_calls`). Never contains prompt or output text. */
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
}

/** Where call records go (the worker wires this to the database). */
export type LlmCallSink = (call: LlmCallRecord) => void | Promise<void>;
