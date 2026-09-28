import { LlmTransportError, type LlmTransport, type LlmTransportRequest, type LlmTransportResponse } from "../transport";
import type { LlmContentPart, LlmMessage } from "../types";
import { toGeminiJsonSchema } from "./gemini-json-schema";
import { retryAfterMs } from "./retry-after";

export interface GeminiTransportOptions {
  apiKey: string;
  /** Per-request HTTP timeout (default 25 s, see DEFAULT_TIMEOUT_MS). */
  timeoutMs?: number;
  baseURL?: string;
  /** For tests: a fetch implementation (no network). */
  fetch?: typeof fetch;
}

/** The parts of the generateContent REST types this adapter sends and reads. */
interface GeminiPart {
  text?: string;
  thought?: boolean;
  inlineData?: { mimeType: string; data: string };
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface GenerateContentResponse {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  modelVersion?: string;
}

interface GeminiErrorBody {
  error?: { message?: string; status?: string; details?: { "@type"?: string; retryDelay?: string }[] };
}

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
/**
 * Gemini sometimes holds a request for minutes before answering (free tier, 2026-09-27: 1 call in
 * 5, up to 185 s for a 400-token answer) while a retry answers in seconds. So a request gives up
 * after 25 s: two stalled attempts and the client's retry still fit in one Stagehand step (60 s)
 * and in the analysis budget (120 s). An answer that legitimately takes longer is cut off too
 * (answers took 1–8 s on the live runs).
 */
const DEFAULT_TIMEOUT_MS = 25_000;
/** Finish reasons that carry the model's answer (MAX_TOKENS a truncated one, left to the client's correction round). */
const ANSWERED = new Set(["STOP", "MAX_TOKENS"]);

/**
 * Gemini Developer API adapter (`generateContent`, API key in the `x-goog-api-key` header, never in
 * the URL). Structured output uses `responseJsonSchema` with the JSON Schema rewritten to the subset
 * Gemini supports. Thinking tokens are billed at the output price, so they are reported as output
 * tokens. No retries: LlmClient owns retry policy.
 */
export class GeminiTransport implements LlmTransport {
  readonly provider = "gemini";
  private readonly baseURL: string;
  private readonly timeoutMs: number;

  constructor(private readonly opts: GeminiTransportOptions) {
    this.baseURL = opts.baseURL ?? DEFAULT_BASE_URL;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async complete(req: LlmTransportRequest): Promise<LlmTransportResponse> {
    const body = {
      ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
      contents: toContents(req.messages),
      generationConfig: {
        responseMimeType: "application/json",
        responseJsonSchema: toGeminiJsonSchema(req.jsonSchema),
        maxOutputTokens: req.maxTokens,
        // "default": no thinkingConfig, the model's own level. Thinking tokens count against maxOutputTokens.
        ...(req.reasoning !== "default" ? { thinkingConfig: { thinkingLevel: req.reasoning.toUpperCase() } } : {}),
      },
    };
    let headers: Headers;
    try {
      headers = new Headers({ "content-type": "application/json", "x-goog-api-key": this.opts.apiKey });
    } catch {
      // The platform's own error quotes the invalid value, i.e. the key: never pass it on.
      throw new LlmTransportError("The Gemini API key is not a valid HTTP header value", { retryable: false });
    }
    const doFetch = this.opts.fetch ?? fetch;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.timeoutMs);
    let res: Response;
    let text: string;
    try {
      res = await doFetch(`${this.baseURL}/models/${encodeURIComponent(req.model)}:generateContent`, {
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
    const data = parseJson(text);
    if (typeof data !== "object" || data === null) {
      throw new LlmTransportError(`Gemini API answered HTTP ${res.status} with a body that is not a JSON object: ${text.slice(0, 300)}`, {
        retryable: false,
      });
    }
    return toResponse(data as GenerateContentResponse, req.model);
  }
}

/**
 * Gemini takes alternating turns: consecutive messages of one role become one turn. Empty text parts
 * are left out (Gemini rejects them), so an empty answer never goes back as a model turn.
 */
function toContents(messages: LlmMessage[]): GeminiContent[] {
  const contents: GeminiContent[] = [];
  for (const m of messages) {
    const role = m.role === "assistant" ? "model" : "user";
    const parts = (typeof m.content === "string" ? [{ text: m.content }] : m.content.map(toPart)).filter((p) => p.text !== "");
    if (parts.length === 0) continue;
    const last = contents.at(-1);
    if (last?.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  }
  return contents;
}

const toPart = (p: LlmContentPart): GeminiPart =>
  p.type === "text" ? { text: p.text } : { inlineData: { mimeType: p.mimeType, data: p.data } };

function toResponse(data: GenerateContentResponse, requestedModel: string): LlmTransportResponse {
  const blocked = data.promptFeedback?.blockReason;
  if (blocked) throw new LlmTransportError(`The prompt was blocked (${blocked})`, { retryable: false });
  const candidate = data.candidates?.[0];
  const reason = candidate?.finishReason;
  if (!candidate || (reason !== undefined && !ANSWERED.has(reason))) {
    throw new LlmTransportError(`The model stopped without an answer (${reason ?? "no candidates"})`, { retryable: false });
  }
  const text = (candidate.content?.parts ?? [])
    .filter((p) => !p.thought && typeof p.text === "string")
    .map((p) => p.text)
    .join("");
  const u = data.usageMetadata ?? {};
  return {
    text,
    model: data.modelVersion ?? requestedModel,
    usage: { inputTokens: u.promptTokenCount ?? 0, outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) },
  };
}

/** Classify HTTP errors: 408/409/429/5xx are retryable; other 4xx are not. */
function httpError(res: Response, text: string): LlmTransportError {
  const error = (parseJson(text) as GeminiErrorBody | undefined)?.error;
  const status = res.status;
  const code = error?.status ? ` ${error.status}` : "";
  return new LlmTransportError(`Gemini API error ${status}${code}: ${error?.message ?? text.slice(0, 300)}`, {
    status,
    retryable: status === 408 || status === 409 || status === 429 || status >= 500,
    retryAfterMs: retryAfterMs(res.headers) ?? retryInfoMs(error?.details),
  });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** `google.rpc.RetryInfo.retryDelay` (a protobuf Duration such as "23s" or "1.5s") in ms. */
function retryInfoMs(details: NonNullable<GeminiErrorBody["error"]>["details"]): number | undefined {
  const delay = details?.find((d) => d["@type"]?.endsWith("google.rpc.RetryInfo"))?.retryDelay;
  const match = delay ? /^(\d+(?:\.\d+)?)s$/.exec(delay) : null;
  return match ? Math.round(Number(match[1]) * 1000) : undefined;
}

function messageWithCause(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return err instanceof Error && err.cause instanceof Error ? `${message} (${err.cause.message})` : message;
}
