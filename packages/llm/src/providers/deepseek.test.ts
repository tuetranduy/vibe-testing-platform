import { describe, expect, it } from "vitest";
import { LlmClient } from "../llm-client";
import { LlmTransportError, type LlmTransportRequest } from "../transport";
import { DeepSeekTransport } from "./deepseek";

type Captured = { url: string; method: string | undefined; body: Record<string, unknown>; headers: Headers };

function fakeFetch(respond: () => Response) {
  const seen: Captured[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), method: init?.method, body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
    return respond();
  }) as typeof fetch;
  return { fn, seen };
}

/** A fetch that never answers: it rejects only when its signal aborts, as fetch does. */
const hangingFetch = (async (_input: string | URL | Request, init?: RequestInit) =>
  new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  })) as typeof fetch;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const okResponse = (content: string | null, extra: Record<string, unknown> = {}) => ({
  id: "930c60df-bf64-41c9-a88e-3ec75f81e00e",
  object: "chat.completion",
  created: 1790000000,
  model: "deepseek-flash",
  choices: [{ index: 0, message: { role: "assistant", content, reasoning_content: "Checking the schema first…" }, finish_reason: "stop", ...extra }],
  usage: {
    prompt_tokens: 120,
    completion_tokens: 290,
    total_tokens: 410,
    prompt_cache_hit_tokens: 64,
    prompt_cache_miss_tokens: 56,
    completion_tokens_details: { reasoning_tokens: 250 },
  },
});

const apiError = (message: string, type = "invalid_request_error") => ({ error: { message, type, param: null, code: null } });

const SCHEMA = {
  type: "object",
  properties: { name: { type: "string", minLength: 1 } },
  required: ["name"],
  additionalProperties: false,
};

const request = (overrides: Partial<LlmTransportRequest> = {}): LlmTransportRequest => ({
  model: "deepseek-flash",
  system: "Be precise.",
  messages: [
    { role: "user", content: "hello" },
    { role: "user", content: [{ type: "text", text: "look:" }, { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }] },
    { role: "assistant", content: '{"name":""}' },
    { role: "user", content: "name must not be empty" },
  ],
  jsonSchema: SCHEMA,
  schemaName: "output",
  maxTokens: 1000,
  reasoning: "default",
  signal: new AbortController().signal,
  ...overrides,
});

const failure = (t: DeepSeekTransport, req = request()) => t.complete(req).then(() => expect.unreachable("expected a failure"), (e: unknown) => e);

describe("DeepSeekTransport", () => {
  it("posts chat completions with a Bearer key, JSON Output and the schema in the system prompt; returns the answer, not the reasoning", async () => {
    const { fn, seen } = fakeFetch(() => json(200, okResponse('{"name":"x"}')));
    const t = new DeepSeekTransport({ apiKey: "sk-ds-test", fetch: fn });

    const res = await t.complete(request());

    // completion_tokens already includes the reasoning tokens (billed as output).
    expect(res).toEqual({ text: '{"name":"x"}', model: "deepseek-flash", usage: { inputTokens: 120, outputTokens: 290 } });
    expect(seen).toHaveLength(1);
    const { url, method, headers, body } = seen[0]!;
    expect(method).toBe("POST");
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    expect(headers.get("authorization")).toBe("Bearer sk-ds-test");
    expect(headers.get("content-type")).toBe("application/json");
    expect(body).toEqual({
      model: "deepseek-flash",
      messages: [
        { role: "system", content: `Be precise.\n\nRespond with a single JSON value and nothing else. The JSON must match this JSON Schema (named "output"):\n${JSON.stringify(SCHEMA)}` },
        { role: "user", content: "hello" },
        { role: "user", content: [{ type: "text", text: "look:" }, { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } }] },
        { role: "assistant", content: '{"name":""}' },
        { role: "user", content: "name must not be empty" },
      ],
      response_format: { type: "json_object" },
      max_tokens: 1000,
    });
  });

  it("an empty system prompt still asks for JSON (JSON Output requires it)", async () => {
    const { fn, seen } = fakeFetch(() => json(200, okResponse("{}")));
    await new DeepSeekTransport({ apiKey: "sk-ds-test", fetch: fn }).complete(request({ system: "" }));
    const [system] = seen[0]!.body.messages as { role: string; content: string }[];
    expect(system).toEqual({ role: "system", content: expect.stringMatching(/^Respond with a single JSON value/) });
  });

  it("a text-only model gets a note in place of each image", async () => {
    const { fn, seen } = fakeFetch(() => json(200, okResponse("{}")));
    await new DeepSeekTransport({ apiKey: "sk-ds-test", fetch: fn }).complete(request({ model: "deepseek-v4-pro" }));
    const messages = seen[0]!.body.messages as { content: unknown }[];
    expect(messages[2]!.content).toEqual([
      { type: "text", text: "look:" },
      { type: "text", text: "[An image was attached here, but this model does not accept images.]" },
    ]);
  });

  it.each([
    ["minimal", { thinking: { type: "disabled" } }],
    ["low", { reasoning_effort: "low" }],
    ["medium", { reasoning_effort: "medium" }],
    ["high", { reasoning_effort: "high" }],
  ] as const)("sends reasoning %s as %j", async (reasoning, params) => {
    const { fn, seen } = fakeFetch(() => json(200, okResponse("{}")));
    await new DeepSeekTransport({ apiKey: "sk-ds-test", fetch: fn }).complete(request({ reasoning }));
    expect(seen[0]!.body).toMatchObject(params);
  });

  it("sends no thinking parameter for the model's default level", async () => {
    const { fn, seen } = fakeFetch(() => json(200, okResponse("{}")));
    await new DeepSeekTransport({ apiKey: "sk-ds-test", fetch: fn }).complete(request({ reasoning: "default" }));
    expect(seen[0]!.body).not.toHaveProperty("thinking");
    expect(seen[0]!.body).not.toHaveProperty("reasoning_effort");
  });

  it("reads a body that starts with the keep-alive blank lines DeepSeek sends while a request is queued", async () => {
    const { fn } = fakeFetch(() => new Response(`\n\n\n${JSON.stringify(okResponse('{"name":"x"}'))}`, { status: 200 }));
    const res = await new DeepSeekTransport({ apiKey: "sk-ds-test", fetch: fn }).complete(request());
    expect(res.text).toBe('{"name":"x"}');
  });

  it("an empty answer (null or blank content) is retried as the same request, not corrected (KI-001)", async () => {
    // DeepSeek's JSON Output "may occasionally return empty content"; two in a row once failed a live run.
    const replies = [json(200, okResponse(null)), json(200, okResponse("  ")), json(200, okResponse('{"name":"x"}'))];
    const { fn, seen } = fakeFetch(() => replies.shift()!);
    const llm = new LlmClient({ transport: new DeepSeekTransport({ apiKey: "sk-ds-test", fetch: fn }), model: "deepseek-flash", retry: { maxRetries: 3, baseDelayMs: 1 } });

    const { data } = await llm.generateJson({
      system: "",
      messages: [{ role: "user", content: "hello" }],
      jsonSchema: SCHEMA,
      stage: "PLANNING",
      runId: "run_1",
      signal: new AbortController().signal,
      redact: (v) => v,
    });

    expect(data).toEqual({ name: "x" });
    expect(seen).toHaveLength(3);
    for (const req of seen) expect((req.body.messages as { role: string }[]).map((m) => m.role)).toEqual(["system", "user"]);

    const err = await failure(new DeepSeekTransport({ apiKey: "sk-ds-test", fetch: fakeFetch(() => json(200, okResponse(null))).fn }));
    expect(err).toMatchObject({ retryable: true });
    expect((err as Error).message).toMatch(/empty answer/i);
  });

  it("finish_reason length returns the partial text, so the client's correction round handles it", async () => {
    const { fn } = fakeFetch(() => json(200, okResponse('{"name":"x', { finish_reason: "length" })));
    const res = await new DeepSeekTransport({ apiKey: "sk-ds-test", fetch: fn }).complete(request());
    expect(res.text).toBe('{"name":"x');
  });

  it("content_filter is a non-retryable error; insufficient_system_resource a retryable one", async () => {
    for (const [reason, retryable] of [
      ["content_filter", false],
      ["insufficient_system_resource", true],
    ] as const) {
      const err = await failure(new DeepSeekTransport({ apiKey: "sk-ds-test", fetch: fakeFetch(() => json(200, okResponse("", { finish_reason: reason }))).fn }));
      expect(err, reason).toMatchObject({ retryable });
      expect((err as Error).message).toContain(reason);
    }
  });

  it("429, 5xx and a proxy's non-JSON 502 are retryable; 400, 401, 402 and 422 are not and carry the API's message", async () => {
    const cases: [Response, number, boolean][] = [
      [json(429, apiError("Rate limit reached", "rate_limit_error"), { "retry-after": "3" }), 429, true],
      [json(500, apiError("Internal server error", "server_error")), 500, true],
      [json(503, apiError("Server overloaded", "server_error")), 503, true],
      [new Response("<html><body>502 Bad Gateway</body></html>", { status: 502, headers: { "content-type": "text/html" } }), 502, true],
      [json(400, apiError("Invalid request body format")), 400, false],
      [json(401, apiError("Authentication Fails, Your api key is invalid", "authentication_error")), 401, false],
      [json(402, apiError("Insufficient Balance")), 402, false],
      [json(422, apiError("Invalid parameter: reasoning_effort")), 422, false],
    ];
    for (const [response, status, retryable] of cases) {
      const err = await failure(new DeepSeekTransport({ apiKey: "sk-ds-test", fetch: fakeFetch(() => response).fn }));
      expect(err, `HTTP ${status}`).toBeInstanceOf(LlmTransportError);
      expect(err, `HTTP ${status}`).toMatchObject({ status, retryable });
    }
    const e429 = await failure(new DeepSeekTransport({ apiKey: "sk-ds-test", fetch: fakeFetch(() => json(429, apiError("slow down"), { "retry-after": "3" })).fn }));
    expect(e429).toMatchObject({ retryAfterMs: 3000 });
    const e402 = await failure(new DeepSeekTransport({ apiKey: "sk-ds-test", fetch: fakeFetch(() => json(402, apiError("Insufficient Balance"))).fn }));
    expect((e402 as Error).message).toBe("DeepSeek API error 402: Insufficient Balance");
  });

  it("a network failure is retryable", async () => {
    const fn = (async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });
    }) as typeof fetch;
    const err = await failure(new DeepSeekTransport({ apiKey: "sk-ds-test", fetch: fn }));
    expect(err).toMatchObject({ retryable: true });
    expect((err as Error).message).toMatch(/fetch failed.*ECONNRESET/);
  });

  it("a request slower than timeoutMs is a retryable timeout; the caller's abort is not retryable", async () => {
    const timedOut = await failure(new DeepSeekTransport({ apiKey: "sk-ds-test", timeoutMs: 20, fetch: hangingFetch }));
    expect(timedOut).toMatchObject({ retryable: true });
    expect((timedOut as Error).message).toMatch(/timed out after 20 ms/);

    const controller = new AbortController();
    const pending = failure(new DeepSeekTransport({ apiKey: "sk-ds-test", fetch: hangingFetch }), request({ signal: controller.signal }));
    controller.abort();
    expect(await pending).toMatchObject({ retryable: false });
  });

  it("an API key that cannot be an HTTP header value fails before any request, without the key in the error", async () => {
    const { fn, seen } = fakeFetch(() => json(200, okResponse("{}")));
    const err = await failure(new DeepSeekTransport({ apiKey: "sk-secret\nkey", fetch: fn }));
    expect(err).toMatchObject({ retryable: false });
    const chain: string[] = [];
    for (let e: unknown = err; e instanceof Error; e = e.cause) chain.push(e.message);
    expect(chain.join(" | ")).not.toContain("sk-secret");
    expect(seen).toHaveLength(0);
  });

  it("a 200 answer that is not JSON (e.g. from a captive portal) is a provider error naming what came back", async () => {
    const { fn } = fakeFetch(() => new Response("<html>Sign in to the network</html>", { status: 200, headers: { "content-type": "text/html" } }));
    const err = await failure(new DeepSeekTransport({ apiKey: "sk-ds-test", fetch: fn }));
    expect(err).toMatchObject({ retryable: false });
    expect((err as Error).message).toMatch(/not a JSON object.*Sign in to the network/);
  });
});
