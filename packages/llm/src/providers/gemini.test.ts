import { describe, expect, it, vi } from "vitest";
import { LlmClient } from "../llm-client";
import { LlmTransportError, type LlmTransportRequest } from "../transport";
import { GeminiTransport } from "./gemini";

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
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=UTF-8", ...headers } });

const usage = { promptTokenCount: 120, candidatesTokenCount: 40, thoughtsTokenCount: 250, totalTokenCount: 410 };

const okResponse = (parts: unknown[], extra: Record<string, unknown> = {}) => ({
  candidates: [{ content: { parts, role: "model" }, finishReason: "STOP", index: 0, ...extra }],
  usageMetadata: { ...usage, promptTokensDetails: [{ modality: "TEXT", tokenCount: 62 }, { modality: "IMAGE", tokenCount: 58 }] },
  modelVersion: "gemini-3.8-flash",
  responseId: "mVTYaJ2cOqGmz7IPmuT6sQs",
});

const apiError = (code: number, status: string, message: string, details: unknown[] = []) => ({ error: { code, message, status, details } });

const request = (overrides: Partial<LlmTransportRequest> = {}): LlmTransportRequest => ({
  model: "gemini-3.8-flash",
  system: "Be precise.",
  messages: [
    { role: "user", content: "hello" },
    { role: "user", content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }] },
    { role: "assistant", content: '{"name":""}' },
    { role: "user", content: "name must not be empty" },
  ],
  jsonSchema: {
    type: "object",
    properties: { name: { type: "string", minLength: 1 }, kind: { type: "string", const: "a" } },
    required: ["name", "kind"],
    additionalProperties: false,
  },
  schemaName: "output",
  maxTokens: 1000,
  signal: new AbortController().signal,
  ...overrides,
});

const failure = (t: GeminiTransport, req = request()) => t.complete(req).then(() => expect.unreachable("expected a failure"), (e: unknown) => e);

describe("GeminiTransport", () => {
  it("posts generateContent with the key in a header, the rewritten schema and merged turns; returns the text and counts thinking as output", async () => {
    const { fn, seen } = fakeFetch(() => json(200, okResponse([{ text: '{"name":"x","kind":"a"}', thoughtSignature: "EpIDCo8DAdHtim" }])));
    const t = new GeminiTransport({ apiKey: "gm-test-key", fetch: fn });

    const res = await t.complete(request());

    // Thinking tokens are billed at the output price, so they are output tokens here.
    expect(res).toEqual({ text: '{"name":"x","kind":"a"}', model: "gemini-3.8-flash", usage: { inputTokens: 120, outputTokens: 290 } });
    expect(seen).toHaveLength(1);
    const { url, method, headers, body } = seen[0]!;
    expect(method).toBe("POST");
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
    expect(headers.get("x-goog-api-key")).toBe("gm-test-key");
    expect(headers.get("content-type")).toBe("application/json");
    expect(body.systemInstruction).toEqual({ parts: [{ text: "Be precise." }] });
    // Consecutive turns of one role become one turn; the assistant is the "model".
    expect(body.contents).toEqual([
      { role: "user", parts: [{ text: "hello" }, { inlineData: { mimeType: "image/png", data: "iVBORw0KGgo=" } }] },
      { role: "model", parts: [{ text: '{"name":""}' }] },
      { role: "user", parts: [{ text: "name must not be empty" }] },
    ]);
    expect(body.generationConfig).toEqual({
      responseMimeType: "application/json",
      responseJsonSchema: {
        type: "object",
        properties: { name: { type: "string", description: "{minLength: 1}" }, kind: { type: "string", enum: ["a"] } },
        required: ["name", "kind"],
        additionalProperties: false,
      },
      maxOutputTokens: 1000,
    });
  });

  it("omits an empty system prompt", async () => {
    const { fn, seen } = fakeFetch(() => json(200, okResponse([{ text: "{}" }])));
    await new GeminiTransport({ apiKey: "gm-test-key", fetch: fn }).complete(request({ system: "" }));
    expect(seen[0]!.body).not.toHaveProperty("systemInstruction");
  });

  it("sends the configured thinking level", async () => {
    const { fn, seen } = fakeFetch(() => json(200, okResponse([{ text: "{}" }])));
    await new GeminiTransport({ apiKey: "gm-test-key", thinkingLevel: "low", fetch: fn }).complete(request());
    expect((seen[0]!.body.generationConfig as Record<string, unknown>).thinkingConfig).toEqual({ thinkingLevel: "LOW" });
  });

  it("never returns thought summaries as answer text", async () => {
    const { fn } = fakeFetch(() => json(200, okResponse([{ text: "Checking the schema first…", thought: true }, { text: '{"name":"x"}' }])));
    const res = await new GeminiTransport({ apiKey: "gm-test-key", fetch: fn }).complete(request());
    expect(res.text).toBe('{"name":"x"}');
  });

  it("sends no empty text part and no empty turn", async () => {
    const { fn, seen } = fakeFetch(() => json(200, okResponse([{ text: "{}" }])));
    await new GeminiTransport({ apiKey: "gm-test-key", fetch: fn }).complete(
      request({
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "" },
          { role: "user", content: [{ type: "text", text: "" }, { type: "text", text: "fix it" }] },
        ],
      }),
    );
    expect(seen[0]!.body.contents).toEqual([{ role: "user", parts: [{ text: "hello" }, { text: "fix it" }] }]);
  });

  it("an answer cut off before any text (thinking used the whole budget) still gets the client's correction round", async () => {
    const replies = [
      json(200, {
        candidates: [{ finishReason: "MAX_TOKENS", index: 0 }],
        usageMetadata: { promptTokenCount: 120, thoughtsTokenCount: 1000, totalTokenCount: 1120 },
        modelVersion: "gemini-3.8-flash",
      }),
      json(200, okResponse([{ text: '{"name":"x","kind":"a"}' }])),
    ];
    const { fn, seen } = fakeFetch(() => replies.shift()!);
    const llm = new LlmClient({ transport: new GeminiTransport({ apiKey: "gm-test-key", fetch: fn }), model: "gemini-3.8-flash" });

    const { data } = await llm.generateJson({
      system: "",
      messages: [{ role: "user", content: "hello" }],
      jsonSchema: request().jsonSchema,
      stage: "PLANNING",
      runId: "run_1",
      signal: new AbortController().signal,
      redact: (v) => v,
    });

    expect(data).toEqual({ name: "x", kind: "a" });
    // The empty answer is not sent back as a model turn (Gemini rejects an empty text part).
    expect(seen[1]!.body.contents).toEqual([
      { role: "user", parts: [{ text: "hello" }, { text: expect.stringContaining("did not pass validation") }] },
    ]);
  });

  it("MAX_TOKENS returns the partial text, so the client's correction round handles it as for any invalid output", async () => {
    const { fn } = fakeFetch(() =>
      json(200, {
        ...okResponse([{ text: '{"name":"x' }], { finishReason: "MAX_TOKENS" }),
        usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 5, thoughtsTokenCount: 995, totalTokenCount: 1120 },
      }),
    );
    const res = await new GeminiTransport({ apiKey: "gm-test-key", fetch: fn }).complete(request());
    expect(res).toEqual({ text: '{"name":"x', model: "gemini-3.8-flash", usage: { inputTokens: 120, outputTokens: 1000 } });
  });

  it("429 → retryable, waiting as long as the error's RetryInfo or the Retry-After header asks", async () => {
    const quota = apiError(429, "RESOURCE_EXHAUSTED", "You exceeded your current quota, please check your plan and billing details.", [
      { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateContentPaidTierInputTokensPerModelPerMinute", quotaValue: "1000000" }] },
      { "@type": "type.googleapis.com/google.rpc.Help", links: [{ description: "Learn more about Gemini API quotas", url: "https://ai.google.dev/gemini-api/docs/rate-limits" }] },
      { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "1.5s" },
    ]);
    const { fn, seen } = fakeFetch(() => json(429, quota));
    const byRetryInfo = await failure(new GeminiTransport({ apiKey: "gm-test-key", fetch: fn }));
    expect(byRetryInfo).toBeInstanceOf(LlmTransportError);
    expect(byRetryInfo).toMatchObject({ status: 429, retryable: true, retryAfterMs: 1500 });
    expect(seen).toHaveLength(1);

    const byHeader = await failure(
      new GeminiTransport({ apiKey: "gm-test-key", fetch: fakeFetch(() => json(429, apiError(429, "RESOURCE_EXHAUSTED", "slow down"), { "retry-after": "7" })).fn }),
    );
    expect(byHeader).toMatchObject({ status: 429, retryable: true, retryAfterMs: 7000 });
  });

  it("408, 409, 5xx and a proxy's non-JSON 502 are retryable; other 4xx are not and carry the API's message", async () => {
    const cases: [Response, number, boolean][] = [
      [json(408, apiError(408, "DEADLINE_EXCEEDED", "Request timed out")), 408, true],
      [json(409, apiError(409, "ABORTED", "The operation was aborted.")), 409, true],
      [json(503, apiError(503, "UNAVAILABLE", "The model is overloaded. Please try again later.")), 503, true],
      [new Response("<html><body>502 Bad Gateway</body></html>", { status: 502, headers: { "content-type": "text/html" } }), 502, true],
      [json(400, apiError(400, "INVALID_ARGUMENT", "Invalid value at 'generation_config.thinking_config.thinking_level'")), 400, false],
      [json(403, apiError(403, "PERMISSION_DENIED", "Method doesn't allow unregistered callers.")), 403, false],
    ];
    for (const [response, status, retryable] of cases) {
      const err = await failure(new GeminiTransport({ apiKey: "gm-test-key", fetch: fakeFetch(() => response).fn }));
      expect(err, `HTTP ${status}`).toMatchObject({ status, retryable });
    }
    const e400 = await failure(
      new GeminiTransport({
        apiKey: "gm-test-key",
        fetch: fakeFetch(() => json(400, apiError(400, "INVALID_ARGUMENT", "Invalid value at 'generation_config.thinking_config.thinking_level'"))).fn,
      }),
    );
    expect((e400 as Error).message).toMatch(/400 INVALID_ARGUMENT.*thinking_level/);
  });

  it("a network failure is retryable", async () => {
    const fn = (async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });
    }) as typeof fetch;
    const err = await failure(new GeminiTransport({ apiKey: "gm-test-key", fetch: fn }));
    expect(err).toMatchObject({ retryable: true });
    expect((err as Error).message).toMatch(/fetch failed.*ECONNRESET/);
  });

  it("a stalled request gives up in time for the client's retries: two stalls and an answer fit in one Stagehand step (60 s)", async () => {
    // Seen live on the free tier: ~1 call in 5 held for minutes, while a retry answered in seconds.
    vi.useFakeTimers();
    const run = new AbortController();
    try {
      let calls = 0;
      const fn = (async (input: string | URL | Request, init?: RequestInit) => {
        calls++;
        return calls <= 2 ? hangingFetch(input, init) : json(200, okResponse([{ text: '{"name":"x","kind":"a"}' }]));
      }) as typeof fetch;
      const llm = new LlmClient({ transport: new GeminiTransport({ apiKey: "gm-test-key", fetch: fn }), model: "gemini-3.8-flash" });
      let settled = false;
      const result = llm.generateJson({
        system: "",
        messages: [{ role: "user", content: "hello" }],
        jsonSchema: request().jsonSchema,
        stage: "EXPLORING",
        runId: "run_1",
        signal: run.signal,
        redact: (v) => v,
      });
      void result.then(
        () => (settled = true),
        () => (settled = true),
      );

      await vi.advanceTimersByTimeAsync(60_000);

      expect(settled).toBe(true);
      await expect(result).resolves.toMatchObject({ data: { name: "x", kind: "a" } });
      expect(calls).toBe(3);
    } finally {
      run.abort();
      vi.useRealTimers();
    }
  });

  it("a request slower than timeoutMs is a retryable timeout; the caller's abort is not retryable", async () => {
    const timedOut = await failure(new GeminiTransport({ apiKey: "gm-test-key", timeoutMs: 20, fetch: hangingFetch }));
    expect(timedOut).toMatchObject({ retryable: true });
    expect((timedOut as Error).message).toMatch(/timed out after 20 ms/);

    const controller = new AbortController();
    const pending = failure(new GeminiTransport({ apiKey: "gm-test-key", fetch: hangingFetch }), request({ signal: controller.signal }));
    controller.abort();
    expect(await pending).toMatchObject({ retryable: false });
  });

  it("an API key that cannot be an HTTP header value fails before any request, without the key in the error", async () => {
    const { fn, seen } = fakeFetch(() => json(200, okResponse([{ text: "{}" }])));
    const err = await failure(new GeminiTransport({ apiKey: "gm-secret\nkey", fetch: fn }));
    expect(err).toMatchObject({ retryable: false });
    // Messages and causes reach the run's errorMessage and the logs, which don't redact the provider key.
    const chain: string[] = [];
    for (let e: unknown = err; e instanceof Error; e = e.cause) chain.push(e.message);
    expect(chain.join(" | ")).not.toContain("gm-secret");
    expect(seen).toHaveLength(0);
  });

  it("a 200 answer that is not JSON (e.g. from a captive portal) is a provider error naming what came back", async () => {
    const { fn } = fakeFetch(() => new Response("<html>Sign in to the network</html>", { status: 200, headers: { "content-type": "text/html" } }));
    const err = await failure(new GeminiTransport({ apiKey: "gm-test-key", fetch: fn }));
    expect(err).toBeInstanceOf(LlmTransportError);
    expect(err).toMatchObject({ retryable: false });
    expect((err as Error).message).toMatch(/not a JSON object.*Sign in to the network/);
  });

  it("a blocked prompt is a non-retryable error naming the reason", async () => {
    const { fn } = fakeFetch(() =>
      json(200, { promptFeedback: { blockReason: "PROHIBITED_CONTENT" }, usageMetadata: { promptTokenCount: 120, totalTokenCount: 120 }, modelVersion: "gemini-3.8-flash" }),
    );
    const err = await failure(new GeminiTransport({ apiKey: "gm-test-key", fetch: fn }));
    expect(err).toMatchObject({ retryable: false });
    expect((err as Error).message).toMatch(/blocked.*PROHIBITED_CONTENT/);
  });

  it("a response stopped for safety, recitation or another reason is a non-retryable error naming it", async () => {
    for (const finishReason of ["SAFETY", "RECITATION", "PROHIBITED_CONTENT", "OTHER"]) {
      const stopped = {
        candidates: [{ finishReason, index: 0, safetyRatings: [{ category: "HARM_CATEGORY_DANGEROUS_CONTENT", probability: "HIGH", blocked: true }] }],
        usageMetadata: { promptTokenCount: 120, totalTokenCount: 120 },
        modelVersion: "gemini-3.8-flash",
      };
      const err = await failure(new GeminiTransport({ apiKey: "gm-test-key", fetch: fakeFetch(() => json(200, stopped)).fn }));
      expect(err, finishReason).toMatchObject({ retryable: false });
      expect((err as Error).message).toContain(finishReason);
    }
  });
});
