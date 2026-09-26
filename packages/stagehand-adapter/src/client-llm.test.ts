import type { ClientLLM } from "@browserbasehq/stagehand";
import { CancelledError, ContractError } from "@platform/contracts";
import { FakeTransport, LlmClient, type LlmCallRecord, type LlmTransportRequest } from "@platform/llm";
import { describe, expect, it } from "vitest";
import { createClientLlmBridge } from "./client-llm";

type GenerateRequest = Parameters<ClientLLM["generate"]>[0];

const silent = { warn() {} };

function setup(opts: { signal?: AbortSignal; redact?: (v: unknown) => unknown } = {}) {
  const transport = new FakeTransport();
  const calls: LlmCallRecord[] = [];
  const llm = new LlmClient({ transport, model: "claude-sonnet-5", recordCall: (c) => void calls.push(c), logger: silent, retry: { maxRetries: 0 } });
  const bridge = createClientLlmBridge({
    llm,
    runId: "run_1",
    signal: opts.signal ?? new AbortController().signal,
    redact: opts.redact ?? ((v) => v),
  });
  return { transport, calls, bridge };
}

const actRequest = (text = "[0-23] button: Add to cart"): GenerateRequest => ({
  systemPrompt: "system text",
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ],
    },
  ],
  responseFormat: { type: "json_schema", name: "Act", schema: { type: "object", properties: { action: {} } } },
});

describe("ClientLLM bridge → @platform/llm", () => {
  it("routes a json_schema request through the structured call and records it as EXPLORING", async () => {
    const { transport, calls, bridge } = setup();
    transport.enqueue({ json: { action: { elementId: "0-23" }, twoStep: false }, usage: { inputTokens: 120, outputTokens: 30 } });

    const result = await bridge.client.generate(actRequest());

    expect(result).toMatchObject({
      role: "assistant",
      outputFormat: "json_schema",
      structuredContent: { action: { elementId: "0-23" }, twoStep: false },
      usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
    });
    const [req] = transport.requests as [LlmTransportRequest];
    expect(req.system).toBe("system text");
    expect(req.schemaName).toBe("Act");
    expect(req.jsonSchema).toEqual({ type: "object", properties: { action: {} } });
    expect(req.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "[0-23] button: Add to cart" },
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        ],
      },
    ]);
    expect(calls).toEqual([expect.objectContaining({ runId: "run_1", stage: "EXPLORING", model: "claude-sonnet-5", inputTokens: 120, outputTokens: 30, status: "SUCCESS" })]);
  });

  it("answers text-mode requests through a { text } envelope", async () => {
    const { transport, bridge } = setup();
    transport.enqueue({ json: { text: "hello" } });
    const result = await bridge.client.generate({ messages: [{ role: "user", content: { type: "text", text: "hi" } }], responseFormat: { type: "text" } } as GenerateRequest);
    expect(result).toMatchObject({ outputFormat: "text", content: { type: "text", text: "hello" } });
    expect(transport.requests[0]?.schemaName).toBe("Text");
  });

  it("rejects tool use and tool content parts (never sent to the provider)", async () => {
    const { transport, bridge } = setup();
    await expect(
      bridge.client.generate({
        messages: [{ role: "user", content: { type: "text", text: "x" } }],
        tools: [{ name: "t", description: "d", inputSchema: { type: "object" } }],
      } as unknown as GenerateRequest),
    ).rejects.toThrow(ContractError);
    await expect(
      bridge.client.generate({
        ...actRequest(),
        messages: [{ role: "user", content: { type: "tool_use", id: "1", name: "t", input: {} } }],
      } as GenerateRequest),
    ).rejects.toThrow(/unsupported message part/);
    expect(bridge.takeError()).toBeInstanceOf(ContractError);
    expect(transport.requests).toHaveLength(0);
  });

  it("applies the run redactor before anything reaches the provider", async () => {
    const redact = (v: unknown) => JSON.parse(JSON.stringify(v).replaceAll("hunter2", "[REDACTED]")) as unknown;
    const { transport, bridge } = setup({ redact });
    transport.enqueue({ json: { action: null } });
    await bridge.client.generate(actRequest("[0-5] textbox: Password hunter2"));
    expect(JSON.stringify(transport.requests)).not.toContain("hunter2");
  });

  it("serializes concurrent generate calls (usage is attributable to one operation)", async () => {
    const { transport, bridge } = setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const order: string[] = [];
    transport.enqueue(
      (req) => {
        order.push(`start ${req.schemaName}`);
        return { json: { first: true } };
      },
      (req) => {
        order.push(`start ${req.schemaName}`);
        return { json: { second: true } };
      },
    );
    const slow = { ...actRequest(), responseFormat: { type: "json_schema", name: "Extraction", schema: {} } } as GenerateRequest;
    const fast = { ...actRequest(), responseFormat: { type: "json_schema", name: "Metadata", schema: {} } } as GenerateRequest;
    // Hold the first call until released, via a transport wrapper.
    const complete = transport.complete.bind(transport);
    let first = true;
    transport.complete = async (req) => {
      if (first) {
        first = false;
        await gate;
      }
      return complete(req);
    };
    const a = bridge.client.generate(slow);
    const b = bridge.client.generate(fast);
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual([]); // the second call has not started while the first is in flight
    release();
    await Promise.all([a, b]);
    expect(order).toEqual(["start Extraction", "start Metadata"]);
  });

  it("takeUsage returns usage since the last take; takeError returns the first failure", async () => {
    const { transport, bridge } = setup();
    transport.enqueue({ json: {}, usage: { inputTokens: 10, outputTokens: 1 } }, { json: {}, usage: { inputTokens: 5, outputTokens: 2 } });
    await bridge.client.generate(actRequest());
    await bridge.client.generate(actRequest());
    expect(bridge.takeUsage()).toEqual({ calls: 2, inputTokens: 15, outputTokens: 3 });
    expect(bridge.takeUsage()).toEqual({ calls: 0, inputTokens: 0, outputTokens: 0 });

    transport.enqueue({ json: ["not", "an", "object"] }, { json: 42 });
    await expect(bridge.client.generate(actRequest())).rejects.toBeInstanceOf(ContractError);
    expect(bridge.takeError()).toBeInstanceOf(ContractError);
    expect(bridge.takeError()).toBeUndefined();
    expect(bridge.model).toBe("claude-sonnet-5");
  });

  it("a non-object structured answer gets the correction round, recorded as INVALID_OUTPUT", async () => {
    const { transport, calls, bridge } = setup();
    transport.enqueue({ json: "just a string" }, { json: { action: null } });
    const result = await bridge.client.generate(actRequest());
    expect(result).toMatchObject({ outputFormat: "json_schema", structuredContent: { action: null } });
    expect(calls.map((c) => c.status)).toEqual(["INVALID_OUTPUT", "SUCCESS"]);
    expect(JSON.stringify(transport.requests[1]!.messages)).toContain("must be a JSON object");

    const failing = setup();
    failing.transport.enqueue({ json: [1] }, { json: [2] });
    await expect(failing.bridge.client.generate(actRequest())).rejects.toBeInstanceOf(ContractError);
    expect(failing.calls.map((c) => c.status)).toEqual(["INVALID_OUTPUT", "INVALID_OUTPUT"]);
  });

  it("an aborted run signal cancels the call", async () => {
    const ac = new AbortController();
    const { transport, bridge } = setup({ signal: ac.signal });
    transport.enqueue("hang");
    const pending = bridge.client.generate(actRequest());
    ac.abort(new CancelledError());
    await expect(pending).rejects.toBeInstanceOf(CancelledError);
  });
});
