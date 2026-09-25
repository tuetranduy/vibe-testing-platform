import Anthropic from "@anthropic-ai/sdk";
import { LlmTransportError, type LlmTransport, type LlmTransportRequest, type LlmTransportResponse } from "../transport";
import type { LlmMessage } from "../types";
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

/**
 * Anthropic Messages API adapter. Structured output uses `output_config.format` with the JSON
 * Schema rewritten to the supported strict subset. SDK retries are disabled: LlmClient owns retry policy.
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
    let message: Anthropic.Message;
    try {
      message = await this.client.messages.create(
        {
          model: req.model,
          max_tokens: req.maxTokens,
          ...(req.system ? { system: req.system } : {}),
          messages: req.messages.map(toMessageParam),
          output_config: { format: { type: "json_schema", schema } },
        },
        { signal: req.signal, timeout: this.timeoutMs, maxRetries: 0 },
      );
    } catch (err) {
      throw toTransportError(err);
    }
    if (message.stop_reason === "refusal") {
      throw new LlmTransportError("The model declined the request", { retryable: false });
    }
    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const u = message.usage;
    return {
      text,
      model: message.model,
      usage: {
        inputTokens: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
        outputTokens: u.output_tokens,
      },
    };
  }
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

function retryAfterMs(headers: Headers | undefined): number | undefined {
  const raw = headers?.get("retry-after");
  if (!raw) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}
