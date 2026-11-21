import type { NormalizedRequirement, PlannedStep, TestScenario } from "@platform/contracts";
import { FakeTransport, LlmClient, type FakeReply } from "@platform/llm";
import { createRunRedactor } from "@platform/security";
import { describe, expect, it } from "vitest";
import { createReplanner, validateReplan, type ReplanInput } from "./replanner";

const requirement: NormalizedRequirement = {
  runId: "run_1",
  revision: 1,
  originalText: "Add a grill to the cart; the cart lists it.",
  criteria: [
    {
      id: "AC-1",
      sourceText: "the cart lists it",
      statement: "The cart lists the grill",
      expectedOutcome: { kind: "collection_contains", collection: { key: "cartItems", checkpoint: "cart_page" }, item: "Fred", match: "contains" },
      preconditions: [],
      critical: true,
      ambiguity: null,
    },
  ],
  facts: [{ key: "cartItems", checkpoint: "cart_page", description: "Names in the cart", valueType: "string_list" }],
  confirmedAt: "2026-11-19T10:00:00.000Z",
};

const planned = (id: string, kind: PlannedStep["kind"], description: string, extra: Partial<PlannedStep> = {}): PlannedStep => ({
  id,
  kind,
  description,
  criterionIds: [],
  destructive: false,
  ...extra,
});

const scenario: TestScenario = {
  id: "SC-1",
  title: "Grill to cart",
  criterionIds: ["AC-1"],
  steps: [
    planned("PS-1", "navigate", "Open https://shop.test/"),
    planned("PS-2", "click", "Click the 'Grills' link"),
    planned("PS-3", "click", "Click 'Add to cart' for Fred"),
    planned("PS-4", "click", "Open the cart"),
    planned("PS-5", "capture_checkpoint", "Capture the cart", { checkpoint: "cart_page", criterionIds: ["AC-1"] }),
  ],
};

const input = (over: Partial<ReplanInput> = {}): ReplanInput => ({
  requirement,
  scenario,
  done: scenario.steps.slice(0, 1),
  failed: scenario.steps[1]!,
  remaining: scenario.steps.slice(2),
  url: "https://shop.test/",
  inventory: { title: "Shop", description: "", headings: [], links: [{ text: "Summer BBQ", url: "https://shop.test/Summer-BBQ/", area: "nav" }], forms: [], buttons: ["Show side menu"] },
  testDataKeys: [],
  secretNames: [],
  firstId: 6,
  targetUrl: "https://shop.test/",
  policy: { allowDestructive: false },
  ...over,
});

const out = (kind: PlannedStep["kind"], description: string, extra: { checkpoint?: string; inputRef?: PlannedStep["inputRef"]; criterionIds?: string[] } = {}) => ({
  kind,
  description,
  inputRef: extra.inputRef ?? null,
  checkpoint: extra.checkpoint ?? null,
  criterionIds: extra.criterionIds ?? [],
  destructive: false,
});

const good = [
  out("navigate", "Open https://shop.test/Summer-BBQ/Grills/"),
  out("click", "Click 'Add to cart' for Fred"),
  out("click", "Open the cart"),
  out("capture_checkpoint", "Capture the cart", { checkpoint: "cart_page" }),
];

function setup(...replies: FakeReply[]) {
  const transport = new FakeTransport().enqueue(...replies);
  const llm = new LlmClient({ transport, model: "claude-sonnet-5", sleep: async () => {} });
  return { transport, llm };
}

const call = { runId: "run_1", signal: new AbortController().signal, redact: createRunRedactor() };

describe("validateReplan", () => {
  it("numbers the new steps from firstId and lists the criteria read at each checkpoint", () => {
    const r = validateReplan({ steps: good }, input());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.steps.map((s) => s.id)).toEqual(["PS-6", "PS-7", "PS-8", "PS-9"]);
    expect(r.steps[3]).toMatchObject({ kind: "capture_checkpoint", checkpoint: "cart_page", criterionIds: ["AC-1"] });
  });

  it("rejects a replan that drops a checkpoint, captures one twice or adds one", () => {
    expect(validateReplan({ steps: good.slice(0, 3) }, input())).toMatchObject({ ok: false });
    expect(validateReplan({ steps: [...good, out("capture_checkpoint", "Again", { checkpoint: "cart_page" })] }, input())).toMatchObject({ ok: false });
    expect(validateReplan({ steps: [...good, out("capture_checkpoint", "Other", { checkpoint: "home" })] }, input())).toMatchObject({ ok: false });
  });

  it("rejects a login the scenario did not plan, a fill without a value reference, and too many steps", () => {
    expect(validateReplan({ steps: [out("login", "Submit the login form"), ...good] }, input())).toMatchObject({ ok: false });
    expect(validateReplan({ steps: [out("fill", "Type the email"), ...good] }, input())).toMatchObject({ ok: false });
    expect(validateReplan({ steps: [...Array.from({ length: 12 }, () => out("click", "Click 'Next'")), ...good] }, input())).toMatchObject({ ok: false });
  });

  it("rejects a secret the scenario never used; a test data key may be new (its value is generated) (review finding)", () => {
    const withLogin = { ...scenario, steps: [...scenario.steps.slice(0, 2), planned("PS-6", "fill", "Type the password", { inputRef: { source: "secret", key: "password" } }), ...scenario.steps.slice(2)] };
    const base = input({ scenario: withLogin, remaining: withLogin.steps.slice(2), secretNames: ["password", "apiKey"], testDataKeys: ["email"], firstId: 7 });
    const fill = (ref: PlannedStep["inputRef"]) => ({ steps: [out("fill", "Type into the field", { inputRef: ref }), ...good] });
    expect(validateReplan(fill({ source: "secret", key: "apiKey" }), base)).toMatchObject({ ok: false });
    expect(validateReplan(fill({ source: "testData", key: "phone" }), base)).toMatchObject({ ok: true });
    expect(validateReplan(fill({ source: "secret", key: "password" }), base)).toMatchObject({ ok: true });
    expect(validateReplan(fill({ source: "testData", key: "email" }), base)).toMatchObject({ ok: true });
  });

  it("past a sign-in prompt the site opened: one login, with any of the run's secrets (KI-080)", () => {
    const steps = [out("fill", "Type the password into the sign-in form", { inputRef: { source: "secret", key: "password" } }), out("login", "Submit the sign-in form"), ...good];
    expect(validateReplan({ steps }, input({ signIn: true, secretNames: ["password"] }))).toMatchObject({ ok: true });
    expect(validateReplan({ steps }, input({ secretNames: ["password"] }))).toMatchObject({ ok: false });
    expect(validateReplan({ steps: [out("login", "Submit"), out("login", "Submit again"), ...good] }, input({ signIn: true }))).toMatchObject({ ok: false });
  });

  it("rejects a criterion id the scenario does not own", () => {
    expect(validateReplan({ steps: [out("click", "Click 'Add to cart'", { criterionIds: ["AC-9"] }), ...good.slice(1)] }, input())).toMatchObject({ ok: false });
  });
});

describe("createReplanner", () => {
  it("none without a model", () => {
    expect(createReplanner(null)).toBeNull();
  });

  it("asks once with the page the browser is on, and returns the validated steps", async () => {
    const { llm, transport } = setup({ json: { steps: good } });
    const steps = await createReplanner(llm)!.replan(input(), call);
    expect(steps?.map((s) => s.id)).toEqual(["PS-6", "PS-7", "PS-8", "PS-9"]);
    const sent = String(transport.requests[0]!.messages[0]!.content);
    expect(transport.requests[0]!.schemaName).toBe("replan");
    expect(sent).toContain("Click the 'Grills' link");
    expect(sent).toContain("Show side menu");
    expect(sent).toContain("https://shop.test/");
  });

  it("leaves room for a reasoning model's thinking: the client's default output budget, not 4,000 tokens (KI-081)", async () => {
    const { llm, transport } = setup({ json: { steps: good } });
    await createReplanner(llm)!.replan(input(), call);
    expect(transport.requests[0]!.maxTokens).toBeGreaterThanOrEqual(16_000);
  });

  it("a step that opened a sign-in prompt: the message says so and how to get past it (KI-080)", async () => {
    const { llm, transport } = setup({ json: { steps: good } }, { json: { steps: good } });
    await createReplanner(llm)!.replan(input({ signIn: true }), call);
    await createReplanner(llm)!.replan(input(), call);
    const [signIn, failed] = transport.requests.map((r) => String(r.messages[0]!.content));
    expect(signIn).toContain("The step that opened a sign-in prompt (JSON):");
    expect(signIn).toContain("continue as a guest");
    expect(signIn).toContain("create a new account");
    expect(failed).toContain("The step that failed (JSON):");
    expect(failed).not.toContain("create a new account");
  });

  it("a step the action policy denies, or an answer still invalid after the correction: no replan", async () => {
    const destructive = setup({ json: { steps: [out("click", "Delete the account"), ...good] } });
    expect(await createReplanner(destructive.llm)!.replan(input(), call)).toBeNull();
    const invalid = setup({ json: { steps: good.slice(0, 1) } }, { json: { steps: good.slice(0, 1) } });
    expect(await createReplanner(invalid.llm)!.replan(input(), call)).toBeNull();
  });

  it("a cancelled run is not swallowed", async () => {
    const { llm } = setup({ json: { steps: good } });
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(createReplanner(llm)!.replan(input(), { ...call, signal: controller.signal })).rejects.toThrow();
  });
});
