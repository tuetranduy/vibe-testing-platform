import { describe, expect, it } from "vitest";
import { LlmTransportError, type LlmTransportRequest } from "../transport";
import { AnthropicTransport } from "./anthropic";

type Captured = { url: string; body: Record<string, unknown>; headers: Headers };

function fakeFetch(respond: () => Response) {
  const seen: Captured[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
    return respond();
  }) as typeof fetch;
  return { fn, seen };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const okMessage = (text: string, extra: Record<string, unknown> = {}) => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5",
  content: [{ type: "text", text }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 120, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  ...extra,
});

const request = (overrides: Partial<LlmTransportRequest> = {}): LlmTransportRequest => ({
  model: "claude-sonnet-5",
  system: "Be precise.",
  messages: [
    { role: "user", content: "hello" },
    { role: "user", content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }] },
  ],
  jsonSchema: {
    type: "object",
    properties: { name: { type: "string", minLength: 1 }, kind: { type: "string", enum: ["a", "b"] } },
    required: ["name", "kind"],
  },
  schemaName: "output",
  maxTokens: 1000,
  reasoning: "default",
  signal: new AbortController().signal,
  ...overrides,
});

describe("AnthropicTransport", () => {
  it("sends a strict json_schema output format, maps parts, and returns text + usage", async () => {
    const { fn, seen } = fakeFetch(() => json(200, okMessage('{"name":"x"}')));
    const t = new AnthropicTransport({ apiKey: "sk-test", fetch: fn });

    const res = await t.complete(request());

    expect(res).toEqual({ text: '{"name":"x"}', model: "claude-sonnet-5", usage: { inputTokens: 120, outputTokens: 40 } });
    expect(seen).toHaveLength(1);
    const body = seen[0]!.body;
    expect(body.model).toBe("claude-sonnet-5");
    expect(body.max_tokens).toBe(1000);
    expect(body.system).toBe("Be precise.");
    const format = (body.output_config as { format: { type: string; schema: Record<string, unknown> } }).format;
    expect(format.type).toBe("json_schema");
    expect(format.schema.additionalProperties).toBe(false);
    // Unsupported constraints are moved out of the schema (validated client-side by Zod).
    const props = format.schema.properties as Record<string, Record<string, unknown>>;
    expect(props.name!.minLength).toBeUndefined();
    expect(props.kind!.enum).toEqual(["a", "b"]); // enums stay enforced by the provider
    expect(body.messages).toEqual([
      { role: "user", content: "hello" },
      { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }] },
    ]);
  });

  it("omits an empty system prompt", async () => {
    const { fn, seen } = fakeFetch(() => json(200, okMessage("{}")));
    await new AnthropicTransport({ apiKey: "sk-test", fetch: fn }).complete(request({ system: "" }));
    expect(seen[0]!.body).not.toHaveProperty("system");
  });

  it("429 → retryable LlmTransportError with retry-after; the SDK does not retry on its own", async () => {
    const { fn, seen } = fakeFetch(() =>
      json(429, { type: "error", error: { type: "rate_limit_error", message: "slow down" } }, { "retry-after": "7" }),
    );
    const err = await new AnthropicTransport({ apiKey: "sk-test", fetch: fn }).complete(request()).catch((e) => e);
    expect(err).toBeInstanceOf(LlmTransportError);
    expect(err).toMatchObject({ status: 429, retryable: true, retryAfterMs: 7000 });
    expect(seen).toHaveLength(1);
  });

  it("5xx → retryable; 400 → not retryable", async () => {
    const e500 = await new AnthropicTransport({
      apiKey: "sk-test",
      fetch: fakeFetch(() => json(529, { type: "error", error: { type: "overloaded_error", message: "busy" } })).fn,
    })
      .complete(request())
      .catch((e) => e);
    expect(e500).toMatchObject({ status: 529, retryable: true });

    const e400 = await new AnthropicTransport({
      apiKey: "sk-test",
      fetch: fakeFetch(() => json(400, { type: "error", error: { type: "invalid_request_error", message: "bad" } })).fn,
    })
      .complete(request())
      .catch((e) => e);
    expect(e400).toMatchObject({ status: 400, retryable: false });
  });

  it("a refusal is a non-retryable provider error", async () => {
    const { fn } = fakeFetch(() => json(200, okMessage("", { stop_reason: "refusal" })));
    const err = await new AnthropicTransport({ apiKey: "sk-test", fetch: fn }).complete(request()).catch((e) => e);
    expect(err).toMatchObject({ retryable: false });
    expect(err.message).toMatch(/declined/);
  });

  it.each(["low", "medium", "high"] as const)("sends reasoning %s as output_config.effort, next to the format", async (reasoning) => {
    const { fn, seen } = fakeFetch(() => json(200, okMessage("{}")));
    await new AnthropicTransport({ apiKey: "sk-test", fetch: fn }).complete(request({ reasoning }));
    const config = seen[0]!.body.output_config as { effort?: string; format: { type: string } };
    expect(config.effort).toBe(reasoning);
    expect(config.format.type).toBe("json_schema");
  });

  it("sends no effort for the model's default level", async () => {
    const { fn, seen } = fakeFetch(() => json(200, okMessage("{}")));
    await new AnthropicTransport({ apiKey: "sk-test", fetch: fn }).complete(request({ reasoning: "default" }));
    expect(seen[0]!.body.output_config).not.toHaveProperty("effort");
  });

  it("refuses minimal, a level Claude does not have, without calling the API (non-retryable)", async () => {
    const { fn, seen } = fakeFetch(() => json(200, okMessage("{}")));
    const err = await new AnthropicTransport({ apiKey: "sk-test", fetch: fn }).complete(request({ reasoning: "minimal" })).catch((e) => e);
    expect(err).toBeInstanceOf(LlmTransportError);
    expect(err).toMatchObject({ retryable: false });
    expect(seen).toHaveLength(0);
  });
});

describe("AnthropicTransport refusal fallback (catalog models marked refusalFallback)", () => {
  /** A fallback-served answer: Fable declined, Opus answered after the `fallback` block. */
  const fallbackAnswer = (usage: Record<string, unknown> = {}) =>
    okMessage("", {
      model: "claude-fable-5-1",
      content: [
        { type: "text", text: '{"par' },
        { type: "fallback", from: { model: "claude-fable-5-1" }, to: { model: "claude-opus-5-5" }, trigger: { type: "refusal", category: "cyber" } },
        { type: "text", text: '{"name":"x"}' },
      ],
      usage: { input_tokens: 120, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...usage },
    });

  it.each(["claude-fable-5-1", "claude-opus-5-5"])("%s goes through the beta Messages API with fallbacks: default", async (model) => {
    const { fn, seen } = fakeFetch(() => json(200, okMessage('{"name":"x"}', { model })));
    await new AnthropicTransport({ apiKey: "sk-test", fetch: fn }).complete(request({ model, reasoning: "high" }));
    expect(seen[0]!.url).toBe("https://api.anthropic.com/v1/messages?beta=true");
    expect(seen[0]!.headers.get("anthropic-beta")).toBe("server-side-fallback-2026-07-01");
    expect(seen[0]!.body).toMatchObject({ model, fallbacks: "default", output_config: { effort: "high", format: { type: "json_schema" } } });
    expect(seen[0]!.body).not.toHaveProperty("betas");
  });

  it.each(["claude-sonnet-5", "claude-haiku-4-5", "claude-opus-5"])("%s uses the Messages API, without fallbacks", async (model) => {
    const { fn, seen } = fakeFetch(() => json(200, okMessage("{}", { model })));
    await new AnthropicTransport({ apiKey: "sk-test", fetch: fn }).complete(request({ model }));
    expect(seen[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(seen[0]!.headers.get("anthropic-beta")).toBeNull();
    expect(seen[0]!.body).not.toHaveProperty("fallbacks");
  });

  it("reports the model that served the fallback (its usage iteration), and returns only that model's text", async () => {
    const iterations = [
      { type: "message", model: "claude-fable-5-1", input_tokens: 60, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null },
      { type: "fallback_message", model: "claude-opus-5-5", input_tokens: 60, output_tokens: 35, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null },
    ];
    const { fn } = fakeFetch(() => json(200, fallbackAnswer({ iterations })));
    const res = await new AnthropicTransport({ apiKey: "sk-test", fetch: fn }).complete(request({ model: "claude-fable-5-1" }));
    expect(res).toEqual({ text: '{"name":"x"}', model: "claude-fable-5-1", usage: { inputTokens: 120, outputTokens: 40 }, fallbackModel: "claude-opus-5-5" });
  });

  it("attributes a multi-hop fallback to the model that produced the final text", async () => {
    const { fn } = fakeFetch(() => json(200, okMessage("", {
      model: "claude-fable-5-1",
      content: [
        { type: "text", text: "declined by Fable" },
        { type: "fallback", from: { model: "claude-fable-5-1" }, to: { model: "claude-sonnet-5" }, trigger: { type: "refusal", category: "cyber" } },
        { type: "text", text: "declined by Sonnet" },
        { type: "fallback", from: { model: "claude-sonnet-5" }, to: { model: "claude-opus-5-5" }, trigger: { type: "refusal", category: "cyber" } },
        { type: "text", text: '{"name":"x"}' },
      ],
      usage: {
        input_tokens: 180, output_tokens: 45,
        iterations: [
          { type: "message", model: "claude-fable-5-1" },
          { type: "fallback_message", model: "claude-sonnet-5" },
          { type: "fallback_message", model: "claude-opus-5-5" },
        ],
      },
    })));
    const res = await new AnthropicTransport({ apiKey: "sk-test", fetch: fn }).complete(request({ model: "claude-fable-5-1" }));
    expect(res).toEqual({
      text: '{"name":"x"}', model: "claude-fable-5-1",
      usage: { inputTokens: 180, outputTokens: 45 }, fallbackModel: "claude-opus-5-5",
    });
  });

  it("without usage iterations, takes the serving model from the last fallback block", async () => {
    const { fn } = fakeFetch(() => json(200, fallbackAnswer({ iterations: null })));
    const res = await new AnthropicTransport({ apiKey: "sk-test", fetch: fn }).complete(request({ model: "claude-fable-5-1" }));
    expect(res.fallbackModel).toBe("claude-opus-5-5");
    expect(res.text).toBe('{"name":"x"}');
  });

  it("an answer from the requested model has no fallbackModel", async () => {
    const { fn } = fakeFetch(() => json(200, okMessage('{"name":"x"}', { model: "claude-opus-5-5" })));
    const res = await new AnthropicTransport({ apiKey: "sk-test", fetch: fn }).complete(request({ model: "claude-opus-5-5" }));
    expect(res).not.toHaveProperty("fallbackModel");
  });

  it("a refusal no fallback rescued stays a non-retryable provider error", async () => {
    const { fn } = fakeFetch(() => json(200, okMessage("", { model: "claude-fable-5-1", stop_reason: "refusal" })));
    const err = await new AnthropicTransport({ apiKey: "sk-test", fetch: fn }).complete(request({ model: "claude-fable-5-1" })).catch((e) => e);
    expect(err).toBeInstanceOf(LlmTransportError);
    expect(err).toMatchObject({ retryable: false });
    expect(err.message).toMatch(/declined/);
  });
});
