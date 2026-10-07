import { FakeTransport, LlmClient, LlmTransportError, type FakeReply } from "@platform/llm";
import { createRunRedactor } from "@platform/security";
import { describe, expect, it } from "vitest";
import { createInputGenerator, fitToField, type FieldFacts, type InputRequest } from "./input-generator";

const field = (over: Partial<FieldFacts> = {}): FieldFacts => ({
  tag: "input",
  type: "text",
  name: null,
  label: null,
  placeholder: null,
  autocomplete: null,
  maxLength: null,
  min: null,
  max: null,
  pattern: null,
  options: [],
  ...over,
});

const request = (over: Partial<InputRequest> = {}): InputRequest => ({
  source: "testData",
  key: "email",
  stepDescription: "Fill the email field",
  field: field({ type: "email", label: "Email address" }),
  runId: "run_1",
  signal: new AbortController().signal,
  redact: createRunRedactor(),
  ...over,
});

function setup(...replies: FakeReply[]) {
  const transport = new FakeTransport().enqueue(...replies);
  const llm = new LlmClient({ transport, model: "claude-sonnet-5", sleep: async () => {} });
  return { transport, llm };
}

describe("createInputGenerator", () => {
  it("asks the model once with the key, the step and the field, and uses its value", async () => {
    const { llm, transport } = setup({ json: { value: "alex.tester@example.com" }, usage: { inputTokens: 300, outputTokens: 20 } });
    const out = await createInputGenerator(llm).generate(request());
    expect(out).toEqual({ value: "alex.tester@example.com", llm: { model: "claude-sonnet-5", inputTokens: 300, outputTokens: 20, cacheHit: null } });
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]!.schemaName).toBe("generate_input");
    const sent = JSON.stringify(transport.requests[0]!.messages);
    expect(sent).toContain("email");
    expect(sent).toContain("Fill the email field");
    expect(sent).toContain("Email address");
  });

  it("tells the model a secret is a password to make up", async () => {
    const { llm, transport } = setup({ json: { value: "Qa-Test-Pass-2026!" } });
    const out = await createInputGenerator(llm).generate(request({ source: "secret", key: "password", field: field({ type: "password" }) }));
    expect(out.value).toBe("Qa-Test-Pass-2026!");
    expect(JSON.stringify(transport.requests[0]!.messages)).toMatch(/secret/i);
  });

  it("a select's value must be one of its options: an answer off the list becomes the first non-empty option", async () => {
    const options = [
      { value: "", label: "Choose…" },
      { value: "no", label: "Norway" },
      { value: "se", label: "Sweden" },
    ];
    const { llm } = setup({ json: { value: "Denmark" } });
    expect((await createInputGenerator(llm).generate(request({ key: "country", field: field({ tag: "select", type: null, options }) }))).value).toBe("no");
  });

  it("without a model (fake engine) or when the call fails, a deterministic value is used: never a block", async () => {
    const none = createInputGenerator(null);
    expect(await none.generate(request())).toEqual({ value: expect.stringMatching(/^qa\.[a-z0-9]+@example\.com$/), llm: null });
    const secret = await none.generate(request({ source: "secret", key: "password", field: field({ type: "password" }) }));
    expect(secret.value).toMatch(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{16}$/);

    const { llm } = setup({ error: new LlmTransportError("down", { status: 500, retryable: false }) });
    expect((await createInputGenerator(llm).generate(request({ key: "city", field: field() }))).value).toBe("Springfield");
  });

  it("an empty answer falls back too", async () => {
    const { llm } = setup({ json: { value: "  " } });
    expect((await createInputGenerator(llm).generate(request({ key: "city", field: field() }))).value).toBe("Springfield");
  });

  it("a run that was cancelled throws instead of falling back", async () => {
    const ac = new AbortController();
    ac.abort(new Error("run cancelled"));
    const { llm } = setup({ json: { value: "x" } });
    await expect(createInputGenerator(llm).generate(request({ signal: ac.signal }))).rejects.toThrow();
  });
});

describe("fitToField", () => {
  it("keeps a select value given as an option's value or its label (as the value)", () => {
    const options = [{ value: "se", label: "Sweden" }];
    expect(fitToField("se", field({ tag: "select", options }))).toBe("se");
    expect(fitToField("sweden", field({ tag: "select", options }))).toBe("se");
  });

  it("cuts a value to the field's maxlength", () => {
    expect(fitToField("1234567890", field({ maxLength: 4 }))).toBe("1234");
    expect(fitToField("12", field({ maxLength: 4 }))).toBe("12");
  });
});
