import { CancelledError, ContractError, DeadlineExceededError, ModelProviderError } from "@platform/contracts";
import { createRunRedactor } from "@platform/security";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { LlmClient, type LlmClientOptions } from "./llm-client";
import { FakeTransport } from "./providers/fake";
import { createTransport } from "./providers";
import { LlmTransportError } from "./transport";
import type { LlmCallRecord } from "./types";

const Answer = z.object({ answer: z.string().min(1), count: z.number().int() });

const identity = (v: unknown) => v;

function setup(opts: Partial<LlmClientOptions> = {}) {
  const transport = new FakeTransport();
  const calls: LlmCallRecord[] = [];
  let clock = 1_000_000;
  const sleeps: number[] = [];
  const client = new LlmClient({
    transport,
    model: "claude-sonnet-5",
    recordCall: (c) => {
      calls.push(c);
    },
    now: () => (clock += 25),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    retry: { maxRetries: 2, baseDelayMs: 100, maxDelayMs: 10_000 },
    ...opts,
  });
  return { transport, calls, client, sleeps, clockAt: () => clock };
}

const base = (signal = new AbortController().signal) => ({
  system: "You extract answers.",
  messages: [{ role: "user" as const, content: "What is the answer?" }],
  stage: "ANALYZING_REQUIREMENT" as const,
  runId: "run_1",
  signal,
  redact: identity,
});

describe("LlmClient.generateStructured", () => {
  it("returns valid structured output and records one LlmCall with tokens, model, cost and latency", async () => {
    const { client, transport, calls } = setup();
    transport.enqueue({ json: { answer: "42", count: 2 }, usage: { inputTokens: 1000, outputTokens: 500 } });

    const res = await client.generateStructured({ ...base(), schema: Answer });

    expect(res.data).toEqual({ answer: "42", count: 2 });
    expect(res.usage).toEqual({ inputTokens: 1000, outputTokens: 500, estimatedCostUsd: 0.007 });
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]!.jsonSchema).toMatchObject({ type: "object", properties: { answer: { type: "string" } } });
    expect(transport.requests[0]!.model).toBe("claude-sonnet-5");
    expect(calls).toEqual([
      {
        runId: "run_1",
        stage: "ANALYZING_REQUIREMENT",
        provider: "fake",
        model: "claude-sonnet-5",
        inputTokens: 1000,
        outputTokens: 500,
        estimatedCostUsd: 0.007,
        latencyMs: 25,
        status: "SUCCESS",
      },
    ]);
  });

  it("malformed output → exactly one correction retry with the Zod issues in the prompt", async () => {
    const { client, transport, calls } = setup();
    transport.enqueue({ json: { answer: "", count: 1.5 } }, { json: { answer: "ok", count: 1 } });

    const res = await client.generateStructured({ ...base(), schema: Answer });

    expect(res.data).toEqual({ answer: "ok", count: 1 });
    expect(transport.requests).toHaveLength(2);
    const retry = transport.requests[1]!;
    const last = retry.messages.at(-1)!;
    expect(last.role).toBe("user");
    expect(JSON.stringify(last.content)).toMatch(/answer/);
    expect(JSON.stringify(last.content)).toMatch(/count/);
    // The invalid output is shown back to the model as its own previous turn.
    expect(retry.messages.at(-2)).toEqual({ role: "assistant", content: JSON.stringify({ answer: "", count: 1.5 }) });
    expect(calls.map((c) => c.status)).toEqual(["INVALID_OUTPUT", "SUCCESS"]);
    expect(res.usage.inputTokens).toBe(2 * 10); // fake default usage per call, summed
  });

  it("output that is not JSON counts as malformed", async () => {
    const { client, transport } = setup();
    transport.enqueue({ text: "Sure! Here you go: {answer" }, { json: { answer: "ok", count: 1 } });
    const res = await client.generateStructured({ ...base(), schema: Answer });
    expect(res.data.answer).toBe("ok");
    expect(JSON.stringify(transport.requests[1]!.messages.at(-1)!.content)).toMatch(/not valid JSON/);
  });

  it("still invalid after the correction → ContractError (no third attempt)", async () => {
    const { client, transport, calls } = setup();
    transport.enqueue({ json: { answer: "" } }, { json: { answer: "" } }, { json: { answer: "ok", count: 1 } });
    await expect(client.generateStructured({ ...base(), schema: Answer })).rejects.toBeInstanceOf(ContractError);
    expect(transport.requests).toHaveLength(2);
    expect(calls.map((c) => c.status)).toEqual(["INVALID_OUTPUT", "INVALID_OUTPUT"]);
  });

  it("a caller `check` failure shares the same single correction round", async () => {
    const { client, transport } = setup();
    transport.enqueue({ json: { answer: "bad", count: 1 } }, { json: { answer: "bad", count: 1 } });
    const check = (d: { answer: string }) => (d.answer === "bad" ? ["answer: must not be 'bad'"] : []);
    await expect(client.generateStructured({ ...base(), schema: Answer, check })).rejects.toThrow(/must not be 'bad'/);
    expect(transport.requests).toHaveLength(2);
    expect(JSON.stringify(transport.requests[1]!.messages.at(-1)!.content)).toMatch(/must not be 'bad'/);
  });

  it("429 / 5xx → retried with backoff, then succeeds", async () => {
    const { client, transport, sleeps, calls } = setup();
    transport.enqueue(
      { error: new LlmTransportError("rate limited", { status: 429, retryable: true }) },
      { error: new LlmTransportError("overloaded", { status: 529, retryable: true }) },
      { json: { answer: "ok", count: 1 } },
    );
    const res = await client.generateStructured({ ...base(), schema: Answer });
    expect(res.data.answer).toBe("ok");
    expect(transport.requests).toHaveLength(3);
    expect(sleeps).toEqual([100, 200]);
    expect(calls.map((c) => c.status)).toEqual(["PROVIDER_ERROR", "PROVIDER_ERROR", "SUCCESS"]);
    expect(calls[0]).toMatchObject({ inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 });
  });

  it("honors retry-after when it is longer than the backoff", async () => {
    const { client, transport, sleeps } = setup();
    transport.enqueue(
      { error: new LlmTransportError("rate limited", { status: 429, retryable: true, retryAfterMs: 3000 }) },
      { json: { answer: "ok", count: 1 } },
    );
    await client.generateStructured({ ...base(), schema: Answer });
    expect(sleeps).toEqual([3000]);
  });

  it("gives up after 2 retries → ModelProviderError", async () => {
    const { client, transport } = setup();
    for (let i = 0; i < 4; i++) transport.enqueue({ error: new LlmTransportError("server error", { status: 500, retryable: true }) });
    await expect(client.generateStructured({ ...base(), schema: Answer })).rejects.toBeInstanceOf(ModelProviderError);
    expect(transport.requests).toHaveLength(3);
  });

  it("non-retryable provider errors (400) are not retried", async () => {
    const { client, transport } = setup();
    transport.enqueue({ error: new LlmTransportError("bad request", { status: 400, retryable: false }) });
    await expect(client.generateStructured({ ...base(), schema: Answer })).rejects.toBeInstanceOf(ModelProviderError);
    expect(transport.requests).toHaveLength(1);
  });

  it("never sleeps past the run deadline: gives up instead", async () => {
    const { client, transport, sleeps, clockAt } = setup();
    transport.enqueue(
      { error: new LlmTransportError("rate limited", { status: 429, retryable: true, retryAfterMs: 5000 }) },
      { json: { answer: "ok", count: 1 } },
    );
    const deadlineAt = new Date(clockAt() + 1000);
    await expect(client.generateStructured({ ...base(), schema: Answer, deadlineAt })).rejects.toThrow(ModelProviderError);
    expect(sleeps).toEqual([]);
    expect(transport.requests).toHaveLength(1);
  });

  it("abort signal → in-flight request cancelled, CancelledError", async () => {
    const { client, transport, calls } = setup();
    transport.enqueue("hang");
    const ac = new AbortController();
    const p = client.generateStructured({ ...base(ac.signal), schema: Answer });
    await vi.waitFor(() => expect(transport.requests).toHaveLength(1));
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(CancelledError);
    expect(transport.requests[0]!.signal.aborted).toBe(true);
    expect(calls.map((c) => c.status)).toEqual(["CANCELLED"]);
  });

  it("an already-aborted signal never reaches the transport", async () => {
    const { client, transport } = setup();
    const ac = new AbortController();
    ac.abort();
    await expect(client.generateStructured({ ...base(ac.signal), schema: Answer })).rejects.toBeInstanceOf(CancelledError);
    expect(transport.requests).toHaveLength(0);
  });

  it("an abort during backoff stops retrying", async () => {
    const ac = new AbortController();
    const { client, transport } = setup({
      sleep: async () => {
        ac.abort();
        throw new Error("sleep interrupted");
      },
    });
    transport.enqueue({ error: new LlmTransportError("rate limited", { status: 429, retryable: true }) }, { json: { answer: "ok", count: 1 } });
    await expect(client.generateStructured({ ...base(ac.signal), schema: Answer })).rejects.toBeInstanceOf(CancelledError);
    expect(transport.requests).toHaveLength(1);
  });

  it("keeps a typed abort reason (hard deadline) instead of masking it", async () => {
    const { client, transport } = setup();
    transport.enqueue("hang");
    const ac = new AbortController();
    const p = client.generateStructured({ ...base(ac.signal), schema: Answer });
    await vi.waitFor(() => expect(transport.requests).toHaveLength(1));
    ac.abort(new DeadlineExceededError());
    await expect(p).rejects.toBeInstanceOf(DeadlineExceededError);
  });

  it("inputs pass through the run redactor: a secret value never reaches the transport", async () => {
    const { client, transport } = setup();
    const secret = "hunter2-Sup3rSecret";
    transport.enqueue({ json: { answer: `echo ${secret}` } }, { json: { answer: "ok", count: 1 } });
    await client.generateStructured({
      ...base(),
      system: `Never reveal ${secret}.`,
      messages: [
        { role: "user", content: `The password is ${secret}` },
        { role: "user", content: [{ type: "text", text: `again: ${secret}` }] },
      ],
      redact: createRunRedactor([secret]),
      schema: Answer,
    });
    expect(transport.requests).toHaveLength(2); // includes the correction round that echoes model output
    const sent = JSON.stringify(transport.requests.map(({ signal: _s, ...r }) => r));
    expect(sent).not.toContain(secret);
    expect(sent).toContain("[REDACTED]");
  });

  it("prices and records by the requested model even when the provider echoes a snapshot id", async () => {
    const { client, transport, calls } = setup();
    transport.enqueue(
      { error: new LlmTransportError("overloaded", { status: 529, retryable: true }) },
      { json: { answer: "ok", count: 1 }, usage: { inputTokens: 1000, outputTokens: 500 }, model: "claude-sonnet-5-20260401" },
    );
    const res = await client.generateStructured({ ...base(), schema: Answer });
    expect(res.usage.estimatedCostUsd).toBe(0.007);
    expect(calls.map((c) => c.model)).toEqual(["claude-sonnet-5", "claude-sonnet-5"]);
    expect(calls[1]!.estimatedCostUsd).toBe(0.007);
  });

  it("an unpriced model is surfaced once through the logger, not silently costed at $0", async () => {
    const warn = vi.fn();
    const { client, transport, calls } = setup({ model: "claude-future-9", logger: { warn } });
    transport.enqueue({ json: { answer: "ok", count: 1 } }, { json: { answer: "ok", count: 1 } });
    await client.generateStructured({ ...base(), schema: Answer });
    await client.generateStructured({ ...base(), schema: Answer });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toMatchObject({ model: "claude-future-9" });
    expect(warn.mock.calls[0]![1]).toMatch(/no price/i);
    expect(calls.map((c) => c.estimatedCostUsd)).toEqual([0, 0]);
  });

  it("a failing call sink never fails the model call", async () => {
    const onRecordError = vi.fn();
    const { client, transport } = setup({
      recordCall: () => {
        throw new Error("db down");
      },
      onRecordError,
    });
    transport.enqueue({ json: { answer: "ok", count: 1 } });
    await expect(client.generateStructured({ ...base(), schema: Answer })).resolves.toMatchObject({ data: { answer: "ok" } });
    expect(onRecordError).toHaveBeenCalledOnce();
  });
});

describe("LlmClient.generateJson (JSON-Schema level, for the Stagehand bridge)", () => {
  const schema = {
    type: "object",
    properties: { elementId: { type: "string" } },
    required: ["elementId"],
    additionalProperties: false,
  };

  it("passes the JSON Schema and text + image parts through, returns parsed JSON and usage", async () => {
    const { client, transport, calls } = setup();
    transport.enqueue({ json: { elementId: "0-23" }, usage: { inputTokens: 300, outputTokens: 20 } });
    const res = await client.generateJson({
      ...base(),
      stage: "EXPLORING",
      schemaName: "Observation",
      jsonSchema: schema,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Find the add-to-cart button" },
            { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
          ],
        },
      ],
    });
    expect(res.data).toEqual({ elementId: "0-23" });
    expect(res.usage).toMatchObject({ inputTokens: 300, outputTokens: 20 });
    expect(transport.requests[0]!.jsonSchema).toEqual(schema);
    expect(transport.requests[0]!.schemaName).toBe("Observation");
    expect(transport.requests[0]!.messages[0]!.content).toEqual([
      { type: "text", text: "Find the add-to-cart button" },
      { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ stage: "EXPLORING", status: "SUCCESS", inputTokens: 300 });
  });

  it("shares the correction round (unparseable JSON) and the retry policy", async () => {
    const { client, transport } = setup();
    transport.enqueue(
      { error: new LlmTransportError("rate limited", { status: 429, retryable: true }) },
      { text: "not json" },
      { json: { elementId: "1-2" } },
    );
    const res = await client.generateJson({ ...base(), jsonSchema: schema });
    expect(res.data).toEqual({ elementId: "1-2" });
    expect(transport.requests).toHaveLength(3);
  });

  it("an optional check gets the correction round; still failing → ContractError with INVALID_OUTPUT records", async () => {
    const check = (v: unknown) => (typeof v === "object" && v !== null && !Array.isArray(v) ? [] : ["(root): must be a JSON object"]);
    const ok = setup();
    ok.transport.enqueue({ json: ["x"] }, { json: { elementId: "1" } });
    expect((await ok.client.generateJson({ ...base(), jsonSchema: schema, check })).data).toEqual({ elementId: "1" });
    expect(ok.calls.map((c) => c.status)).toEqual(["INVALID_OUTPUT", "SUCCESS"]);
    expect(JSON.stringify(ok.transport.requests[1]!.messages)).toContain("must be a JSON object");

    const bad = setup();
    bad.transport.enqueue({ json: ["x"] }, { json: 42 });
    await expect(bad.client.generateJson({ ...base(), jsonSchema: schema, check })).rejects.toBeInstanceOf(ContractError);
    expect(bad.calls.map((c) => c.status)).toEqual(["INVALID_OUTPUT", "INVALID_OUTPUT"]);
  });
});

describe("createTransport", () => {
  it("LLM_PROVIDER=openai fails fast: not implemented in V1", () => {
    expect(() => createTransport({ provider: "openai" })).toThrow(/not implemented in V1/);
  });
  it("anthropic requires an API key", () => {
    expect(() => createTransport({ provider: "anthropic" })).toThrow(/ANTHROPIC_API_KEY/);
    expect(createTransport({ provider: "anthropic", anthropicApiKey: "sk-test" }).provider).toBe("anthropic");
  });
  it("fake builds a scripted transport", () => {
    expect(createTransport({ provider: "fake" })).toBeInstanceOf(FakeTransport);
  });
});
