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
    const { llm, transport } = setup({ json: { value: "Alex" }, usage: { inputTokens: 300, outputTokens: 20 } });
    const out = await createInputGenerator(llm).generate(request({ key: "first_name", stepDescription: "Fill the first name", field: field({ label: "First name *" }) }));
    expect(out).toEqual({ value: "Alex", llm: { model: "claude-sonnet-5", inputTokens: 300, outputTokens: 20, cacheHit: null } });
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]!.schemaName).toBe("generate_input");
    const sent = JSON.stringify(transport.requests[0]!.messages);
    expect(sent).toContain("first_name");
    expect(sent).toContain("Fill the first name");
    expect(sent).toContain("First name *");
  });

  it("an email is never the model's (it repeats one address, KI-063): unique to the run and the key, with no model call", async () => {
    const { llm, transport } = setup();
    const gen = createInputGenerator(llm);
    const a = await gen.generate(request());
    expect(a).toEqual({ value: expect.stringMatching(/^qa\.[a-z0-9]+@example\.com$/), llm: null });
    expect(transport.requests).toHaveLength(0);
    expect((await gen.generate(request())).value).toBe(a.value);
    expect((await gen.generate(request({ runId: "run_2" }))).value).not.toBe(a.value);
    // By the field's type or label too, whatever the key is called.
    expect((await gen.generate(request({ key: "login", field: field({ type: "text", label: "E-mail" }) }))).value).toMatch(/@example\.com$/);
    expect((await gen.generate(request({ key: "contact", field: field({ type: "email" }) }))).value).toMatch(/@example\.com$/);
    expect(transport.requests).toHaveLength(0);
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

  it("fits a fallback password to the field's maxlength, with or without a model", async () => {
    const req = request({ source: "secret", key: "password", field: field({ type: "password", maxLength: 12 }) });
    expect((await createInputGenerator(null).generate(req)).value).toMatch(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{12}$/);
    const { llm } = setup({ json: { value: "" } });
    expect((await createInputGenerator(llm).generate(req)).value).toHaveLength(12);
  });

  it("a run that was cancelled throws instead of falling back", async () => {
    const ac = new AbortController();
    ac.abort(new Error("run cancelled"));
    const { llm } = setup({ json: { value: "x" } });
    await expect(createInputGenerator(llm).generate(request({ key: "city", field: field(), signal: ac.signal }))).rejects.toThrow();
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
  it("a number field gets a number inside min and max, whatever the model said", () => {
    const qty = field({ type: "number", min: "1", max: "9" });
    expect(fitToField("3", qty)).toBe("3");
    expect(fitToField("25", qty)).toBe("9");
    expect(fitToField("0", qty)).toBe("1");
    expect(fitToField("about 4 items", qty)).toBe("4");
    expect(fitToField("several", qty)).toBe("1");
    expect(fitToField("many", field({ type: "number" }))).toBe("1");
    expect(fitToField("2.5", field({ type: "range", min: "0", max: "1" }))).toBe("1");
  });

  it("a date or time field gets the browser's format, moved inside min and max", () => {
    expect(fitToField("2031-05-20", field({ type: "date" }))).toBe("2031-05-20");
    expect(fitToField("May 20, 2031", field({ type: "date" }))).toBe("2030-01-15");
    expect(fitToField("2031-13-40", field({ type: "date" }))).toBe("2030-01-15");
    expect(fitToField("2030-01-15", field({ type: "date", max: "2026-11-11" }))).toBe("2026-11-11");
    expect(fitToField("1990-01-15", field({ type: "date", min: "2027-01-01" }))).toBe("2027-01-01");
    expect(fitToField("soon", field({ type: "date", min: "not a date" }))).toBe("2030-01-15");
    expect(fitToField("10am", field({ type: "time" }))).toBe("10:00");
    expect(fitToField("2031-05", field({ type: "month" }))).toBe("2031-05");
    expect(fitToField("next year", field({ type: "datetime-local" }))).toBe("2030-01-15T10:00");
  });

  it("a value the field's pattern refuses is rewritten when dropping separators is enough; otherwise it is kept", () => {
    const digits = field({ type: "tel", pattern: "[0-9]{6,12}" });
    expect(fitToField("5550123456", digits)).toBe("5550123456");
    expect(fitToField("+1 555 0123", digits)).toBe("15550123");
    expect(fitToField("TEST-AB12", field({ pattern: "[A-Z0-9]+" }))).toBe("TESTAB12");
    expect(fitToField("Alex", field({ pattern: "[0-9]+" }))).toBe("Alex");
    // A pattern that does not compile is ignored, and the rewrite still respects maxlength.
    expect(fitToField("Alex", field({ pattern: "[a-" }))).toBe("Alex");
    expect(fitToField("12-34-56-78", field({ pattern: "\\d{4}", maxLength: 4 }))).toBe("1234");
  });
});
