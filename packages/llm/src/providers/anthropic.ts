import Anthropic from "@anthropic-ai/sdk";
import type { ReasoningLevel } from "@platform/contracts";
import { catalogModel } from "../catalog";
import { LlmTransportError, type LlmTransport, type LlmTransportRequest, type LlmTransportResponse } from "../transport";
import type { LlmMessage } from "../types";
import { retryAfterMs } from "./retry-after";
import { toStrictJsonSchema } from "./strict-json-schema";

export interface AnthropicTransportOptions {
  apiKey: string;
  /** Per-request HTTP timeout. */
  timeoutMs?: number;
  baseURL?: string;
  /** For tests: a fetch implementation (no network). */
  fetch?: typeof fetch;
}

type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/** The beta that lets the API retry a refused request on the model Anthropic recommends (`fallbacks: "default"`). */
export const SERVER_SIDE_FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** A run's reasoning level as Claude's `output_config.effort`; "default" sends none (the model's own). */
function effortOf(reasoning: ReasoningLevel): { effort: "low" | "medium" | "high" } | Record<string, never> {
  switch (reasoning) {
    case "default":
      return {};
    case "low":
    case "medium":
    case "high":
      return { effort: reasoning };
    case "minimal":
      throw new LlmTransportError("Claude models take the reasoning levels low, medium and high, not minimal", { retryable: false });
  }
}

/** What this adapter reads from a Messages (or beta Messages) response. */
interface MessageLike {
  content: readonly { type: string }[];
  stop_reason: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    iterations?: readonly { type: string; model?: string | null }[] | null;
  };
  model: string;
}

type TextBlock = { type: "text"; text: string };
type FallbackBlock = { type: "fallback"; to: { model: string } };
const isText = (b: { type: string }): b is TextBlock => b.type === "text";
const isFallback = (b: { type: string }): b is FallbackBlock => b.type === "fallback";

/**
 * Anthropic Messages API adapter. Structured output uses `output_config.format` with the JSON
 * Schema rewritten to the supported strict subset, and the run's reasoning level as
 * `output_config.effort`. Catalog models marked `refusalFallback` go through the beta Messages API
 * with `fallbacks: "default"`: a request the model's safety classifiers decline is retried by the API
 * on the model Anthropic recommends, and the response names that model (`fallbackModel`). SDK retries
 * are disabled: LlmClient owns retry policy.
 */
export class AnthropicTransport implements LlmTransport {
  readonly provider = "anthropic";
  private readonly client: Anthropic;
  private readonly timeoutMs: number;

  constructor(opts: AnthropicTransportOptions) {
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      maxRetries: 0,
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  async complete(req: LlmTransportRequest): Promise<LlmTransportResponse> {
    let schema: Record<string, unknown>;
    try {
      schema = toStrictJsonSchema(req.jsonSchema);
    } catch (err) {
      throw new LlmTransportError(`Unsupported JSON schema: ${(err as Error).message}`, { retryable: false, cause: err });
    }
    const params = {
      model: req.model,
      max_tokens: req.maxTokens,
      ...(req.system ? { system: req.system } : {}),
      messages: req.messages.map(toMessageParam),
      output_config: { format: { type: "json_schema" as const, schema }, ...effortOf(req.reasoning) },
    };
    const options = { signal: req.signal, timeout: this.timeoutMs, maxRetries: 0 };
    let message: MessageLike;
    try {
      message = catalogModel(req.model)?.refusalFallback
        ? await this.client.beta.messages.create({ ...params, fallbacks: "default", betas: [SERVER_SIDE_FALLBACK_BETA] }, options)
        : await this.client.messages.create(params, options);
    } catch (err) {
      throw toTransportError(err);
    }
    if (message.stop_reason === "refusal") {
      throw new LlmTransportError("The model declined the request", { retryable: false });
    }
    // After a fallback, only the serving model's output counts: the text after the last `fallback` block.
    const lastFallback = message.content.findLastIndex(isFallback);
    const text = message.content
      .slice(lastFallback + 1)
      .filter(isText)
      .map((b) => b.text)
      .join("");
    const u = message.usage;
    const fallbackModel = servingFallbackModel(message);
    return {
      text,
      model: message.model,
      usage: {
        inputTokens: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
        outputTokens: u.output_tokens,
      },
      ...(fallbackModel ? { fallbackModel } : {}),
    };
  }
}

/**
 * The model that served a fallback-answered response: the last `fallback_message` usage iteration (the API's
 * signal that a fallback served it), else the last `fallback` content block's target. Undefined otherwise.
 */
function servingFallbackModel(message: MessageLike): string | undefined {
  const served = message.usage.iterations?.filter((i) => i.type === "fallback_message").at(-1)?.model;
  if (served) return served;
  return message.content.filter(isFallback).at(-1)?.to.model;
}

function toMessageParam(m: LlmMessage): Anthropic.MessageParam {
  if (typeof m.content === "string") return { role: m.role, content: m.content };
  return {
    role: m.role,
    content: m.content.map((p): Anthropic.TextBlockParam | Anthropic.ImageBlockParam =>
      p.type === "text"
        ? { type: "text", text: p.text }
        : { type: "image", source: { type: "base64", media_type: p.mimeType as ImageMediaType, data: p.data } },
    ),
  };
}

/** Classify SDK errors: 408/409/429/5xx and connection failures are retryable; other 4xx are not. */
function toTransportError(err: unknown): LlmTransportError {
  if (err instanceof Anthropic.APIUserAbortError) {
    return new LlmTransportError("Request aborted", { retryable: false, cause: err });
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new LlmTransportError(`Connection error: ${err.message}`, { retryable: true, cause: err });
  }
  if (err instanceof Anthropic.APIError) {
    const status = err.status;
    const retryable = status === 408 || status === 409 || status === 429 || (status !== undefined && status >= 500);
    return new LlmTransportError(`Anthropic API error ${status ?? "?"}: ${err.message}`, {
      status,
      retryable,
      retryAfterMs: retryAfterMs(err.headers),
      cause: err,
    });
  }
  return new LlmTransportError(`Unexpected error: ${(err as Error)?.message ?? String(err)}`, { retryable: false, cause: err });
}
