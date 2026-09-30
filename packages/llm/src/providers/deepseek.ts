import type { ReasoningLevel } from "@platform/contracts";
import { LlmTransportError, type LlmTransport, type LlmTransportRequest, type LlmTransportResponse } from "../transport";
import type { JsonSchema, LlmContentPart, LlmMessage } from "../types";
import { messageWithCause, parseJson } from "./http";
import { retryAfterMs } from "./retry-after";

export interface DeepSeekTransportOptions {
  apiKey: string;
  /** Per-request HTTP timeout (default 120 s). */
  timeoutMs?: number;
  baseURL?: string;
  /** For tests: a fetch implementation (no network). */
  fetch?: typeof fetch;
}

/** The parts of the Chat Completions REST types this adapter sends and reads. */
type DeepSeekContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

interface DeepSeekMessage {
  role: "system" | "user" | "assistant";
  content: string | DeepSeekContentPart[];
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  model?: string;
}

interface DeepSeekErrorBody {
  error?: { message?: string; type?: string; code?: string | null };
}

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_TIMEOUT_MS = 120_000;
/** Finish reasons that carry the model's answer (`length` a truncated one, left to the client's correction round). */
const ANSWERED = new Set(["stop", "length"]);
/** Models that take no image input (checked 2026-09-30): an image is replaced by a note saying it was left out. */
const TEXT_ONLY_MODELS = new Set(["deepseek-v4-pro"]);
const IMAGE_LEFT_OUT = "[An image was attached here, but this model does not accept images.]";

/**
 * A run's reasoning level as DeepSeek's thinking parameters. "default" sends none (thinking on, effort
 * high); "minimal" turns thinking off; the others are `reasoning_effort` (DeepSeek runs "medium" as "high").
 */
function thinkingOf(reasoning: ReasoningLevel): Record<string, unknown> {
  switch (reasoning) {
    case "default":
      return {};
    case "minimal":
      return { thinking: { type: "disabled" } };
    case "low":
    case "medium":
    case "high":
      return { reasoning_effort: reasoning };
  }
}

/**
 * DeepSeek Chat Completions adapter (OpenAI-compatible `POST /chat/completions`, API key as a Bearer
 * token). DeepSeek's JSON Output (`response_format: json_object`) guarantees valid JSON but takes no
 * schema, so the schema goes into the system prompt (which must mention JSON) and LlmClient validates
 * the answer. Thinking tokens are part of `completion_tokens` and billed as output. No retries:
 * LlmClient owns retry policy.
 */
export class DeepSeekTransport implements LlmTransport {
  readonly provider = "deepseek";
  private readonly baseURL: string;
  private readonly timeoutMs: number;

  constructor(private readonly opts: DeepSeekTransportOptions) {
    this.baseURL = opts.baseURL ?? DEFAULT_BASE_URL;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async complete(req: LlmTransportRequest): Promise<LlmTransportResponse> {
    const body = {
      model: req.model,
      messages: [
        { role: "system", content: withSchemaInstruction(req.system, req.jsonSchema, req.schemaName) },
        ...toMessages(req.messages, !TEXT_ONLY_MODELS.has(req.model)),
      ],
      response_format: { type: "json_object" },
      // Thinking tokens count against max_tokens.
      max_tokens: req.maxTokens,
      ...thinkingOf(req.reasoning),
    };
    let headers: Headers;
    try {
      headers = new Headers({ "content-type": "application/json", authorization: `Bearer ${this.opts.apiKey}` });
    } catch {
      // The platform's own error quotes the invalid value, i.e. the key: never pass it on.
      throw new LlmTransportError("The DeepSeek API key is not a valid HTTP header value", { retryable: false });
    }
    const doFetch = this.opts.fetch ?? fetch;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.timeoutMs);
    let res: Response;
    let text: string;
    try {
      res = await doFetch(`${this.baseURL}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.any([req.signal, timeout.signal]),
      });
      text = await res.text();
    } catch (err) {
      if (req.signal.aborted) throw new LlmTransportError("Request aborted", { retryable: false, cause: err });
      if (timeout.signal.aborted) throw new LlmTransportError(`Request timed out after ${this.timeoutMs} ms`, { retryable: true, cause: err });
      if (err instanceof TypeError) throw new LlmTransportError(`Connection error: ${messageWithCause(err)}`, { retryable: true, cause: err });
      throw new LlmTransportError(`Unexpected error: ${messageWithCause(err)}`, { retryable: false, cause: err });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw httpError(res, text);
    // While a request waits in DeepSeek's queue the body starts with keep-alive blank lines; JSON.parse skips them.
    const data = parseJson(text);
    if (typeof data !== "object" || data === null) {
      throw new LlmTransportError(`DeepSeek API answered HTTP ${res.status} with a body that is not a JSON object: ${text.slice(0, 300)}`, {
        retryable: false,
      });
    }
    return toResponse(data as ChatCompletionResponse, req.model);
  }
}

/**
 * JSON Output needs the prompt to ask for JSON (otherwise the model may stream whitespace until
 * max_tokens), and it takes no schema: both go after the caller's system prompt.
 */
function withSchemaInstruction(system: string, schema: JsonSchema, name: string): string {
  const instruction =
    `Respond with a single JSON value and nothing else. The JSON must match this JSON Schema (named "${name}"):\n` +
    JSON.stringify(schema);
  return system ? `${system}\n\n${instruction}` : instruction;
}

/**
 * User turns keep their parts (images as base64 data URLs, or a note for a text-only model); assistant
 * turns are sent as text. An empty assistant turn is left out, so an empty answer never goes back.
 */
function toMessages(messages: LlmMessage[], vision: boolean): DeepSeekMessage[] {
  const out: DeepSeekMessage[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      const text = typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? p.text : "")).join("");
      if (text !== "") out.push({ role: "assistant", content: text });
    } else {
      out.push({ role: "user", content: typeof m.content === "string" ? m.content : m.content.map((p) => toPart(p, vision)) });
    }
  }
  return out;
}

function toPart(p: LlmContentPart, vision: boolean): DeepSeekContentPart {
  if (p.type === "text") return { type: "text", text: p.text };
  if (!vision) return { type: "text", text: IMAGE_LEFT_OUT };
  return { type: "image_url", image_url: { url: `data:${p.mimeType};base64,${p.data}` } };
}

function toResponse(data: ChatCompletionResponse, requestedModel: string): LlmTransportResponse {
  const choice = data.choices?.[0];
  const reason = choice?.finish_reason ?? undefined;
  if (!choice || (reason !== undefined && !ANSWERED.has(reason))) {
    // insufficient_system_resource: DeepSeek ran out of capacity mid-answer; a retry may be served.
    throw new LlmTransportError(`The model stopped without an answer (${reason ?? "no choices"})`, {
      retryable: reason === "insufficient_system_resource",
    });
  }
  const u = data.usage ?? {};
  return {
    text: choice.message?.content ?? "",
    model: data.model ?? requestedModel,
    usage: { inputTokens: u.prompt_tokens ?? 0, outputTokens: u.completion_tokens ?? 0 },
  };
}

/** Classify HTTP errors: 408/409/429/5xx are retryable; other 4xx (e.g. 402, out of balance) are not. */
function httpError(res: Response, text: string): LlmTransportError {
  const error = (parseJson(text) as DeepSeekErrorBody | undefined)?.error;
  const status = res.status;
  return new LlmTransportError(`DeepSeek API error ${status}: ${error?.message ?? text.slice(0, 300)}`, {
    status,
    retryable: status === 408 || status === 409 || status === 429 || status >= 500,
    retryAfterMs: retryAfterMs(res.headers),
  });
}
