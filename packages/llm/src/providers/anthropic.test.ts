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
});
