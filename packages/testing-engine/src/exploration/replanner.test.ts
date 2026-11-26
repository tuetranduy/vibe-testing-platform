import type { NormalizedRequirement, PlannedStep, TestScenario } from "@platform/contracts";
import { FakeTransport, LlmClient, type FakeReply } from "@platform/llm";
import { createRunRedactor } from "@platform/security";
import { describe, expect, it } from "vitest";
import { buildReplanPrompt, createReplanner, validateReplan, type ReplanInput } from "./replanner";

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
    // It replaces the failed step and the 3 after it, plus at most 15 more: 19 (KI-095).
    expect(validateReplan({ steps: [...Array.from({ length: 16 }, () => out("click", "Click 'Next'")), ...good] }, input())).toMatchObject({ ok: false, issues: ["at most 19 steps (got 20)"] });
  });

  it("may replan everything it replaces: a long form flow's remaining steps plus the recovery (KI-095, run_0mwt0qo61004917dd94a73b19)", () => {
    // The failed step had 28 steps after it; the replan of all 29, plus a recovery step, was rejected at 15.
    const long = Array.from({ length: 28 }, (_, i) => planned(`PS-${10 + i}`, "click", `Click option ${i}`));
    const base = input({ remaining: [...long, scenario.steps[4]!] });
    const steps = [...Array.from({ length: 29 }, (_, i) => out("click", `Click option ${i}`)), ...good];
    expect(validateReplan({ steps }, base)).toMatchObject({ ok: true });
    // 1 failed + 29 after it + 15: 45.
    expect(validateReplan({ steps: [...Array.from({ length: 13 }, () => out("click", "Click 'Next'")), ...steps] }, base)).toMatchObject({ ok: false, issues: ["at most 45 steps (got 46)"] });
  });

  it("never plans past the room the plan has left (maxSteps)", () => {
    expect(validateReplan({ steps: good }, input({ maxSteps: 3 }))).toMatchObject({ ok: false, issues: ["at most 3 steps (got 4)"] });
    expect(validateReplan({ steps: good }, input({ maxSteps: 4 }))).toMatchObject({ ok: true });
  });

  it("an arrival refinement may add up to 30 steps to what it rewrites", () => {
    const steps = [...Array.from({ length: 30 }, () => out("click", "Click 'Next'")), ...good];
    expect(validateReplan({ steps }, input({ arrived: true }))).toMatchObject({ ok: true });
    expect(validateReplan({ steps: [out("click", "One more"), ...steps] }, input({ arrived: true }))).toMatchObject({ ok: false, issues: ["at most 34 steps (got 35)"] });
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

  it("a made-up account value is a named test data key, never a literal, so a later login types it again (run_0mwx76owz55f67d2ad3bdc8a1)", () => {
    const pw = (inputRef: PlannedStep["inputRef"]) => ({ steps: [out("fill", "Type the chosen password into the 'Mật khẩu' (password) field", { inputRef }), ...good] });
    expect(validateReplan(pw({ source: "literal", key: "password123" }), input())).toMatchObject({ ok: false, issues: [expect.stringMatching(/^steps\.0\.inputRef: a literal is only for a value written in the requirement/)] });
    expect(validateReplan(pw({ source: "testData", key: "new_account_password" }), input())).toMatchObject({ ok: true });
  });

  it("may type again a value another scenario made up, but never a saved secret it typed (2026-11-26)", () => {
    const entered = [
      { inputRef: { source: "secret" as const, key: "new_account_password" }, field: "Type the password into the registration form" },
      { inputRef: { source: "secret" as const, key: "password" }, field: "Type the password into the sign-in form" },
    ];
    const pw = (key: string) => ({ steps: [out("fill", "Type the password of the new account", { inputRef: { source: "secret", key } }), ...good] });
    expect(validateReplan(pw("new_account_password"), input({ entered, secretNames: ["password"] }))).toMatchObject({ ok: true });
    expect(validateReplan(pw("password"), input({ entered, secretNames: ["password"] }))).toMatchObject({ ok: false });
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
    expect(steps.steps?.map((s) => s.id)).toEqual(["PS-6", "PS-7", "PS-8", "PS-9"]);
    const sent = String(transport.requests[0]!.messages[0]!.content);
    expect(transport.requests[0]!.schemaName).toBe("replan");
    expect(sent).toContain("Click the 'Grills' link");
    expect(sent).toContain("Show side menu");
    expect(sent).toContain("https://shop.test/");
  });

  it("leaves room for a reasoning model's thinking and a long replan: the planner's budget and timeout (KI-081, KI-095)", async () => {
    const { llm, transport } = setup({ json: { steps: good } });
    await createReplanner(llm)!.replan(input(), call);
    expect(transport.requests[0]!.maxTokens).toBe(32_000);
    expect(transport.requests[0]!.timeoutMs).toBe(300_000);
  });

  it("tells the model which values the run already entered, in every scenario, by reference only", () => {
    const entered = [{ inputRef: { source: "testData" as const, key: "new_account_password" }, field: "Type the password into the registration form" }];
    const prompt = buildReplanPrompt(input({ entered }));
    expect(prompt).toContain('Values already entered in this run, in every scenario (JSON; the same "inputRef" types the same value again): [{"inputRef":{"source":"testData","key":"new_account_password"},"field":"Type the password into the registration form"}]');
    expect(buildReplanPrompt(input())).not.toContain("Values already entered");
  });

  it("tells the model this replan's step limit", () => {
    expect(buildReplanPrompt(input())).toContain("At most 19 steps");
    expect(buildReplanPrompt(input({ maxSteps: 7 }))).toContain("At most 7 steps");
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
    expect(await createReplanner(destructive.llm)!.replan(input(), call)).toMatchObject({ steps: null, reason: "action_blocked" });
    const invalid = setup({ json: { steps: good.slice(0, 1) } }, { json: { steps: good.slice(0, 1) } });
    expect(await createReplanner(invalid.llm)!.replan(input(), call)).toMatchObject({ steps: null, reason: "validation_failed", issues: [expect.stringContaining("never captured")] });
  });

  it("a value-entry step the model flagged destructive is kept, unflagged (KI-093)", async () => {
    const flagged = { ...out("select", "Select the purchased date", { inputRef: { source: "literal", key: "01/12/2022" } }), destructive: true };
    const { llm } = setup({ json: { steps: [flagged, ...good] } });
    const result = await createReplanner(llm)!.replan(input(), call);
    expect(result.steps?.map((s) => [s.kind, s.destructive])).toEqual([["select", false], ["navigate", false], ["click", false], ["click", false], ["capture_checkpoint", false]]);
  });

  it("reports a failed model call separately from validation", async () => {
    const { llm } = setup();
    expect(await createReplanner(llm)!.replan(input(), call)).toEqual({ steps: null, reason: "model_failed" });
  });

  it("rejects a single denied step even when blocking substitutes a one-step fallback with the same id (KI-086)", async () => {
    const { llm } = setup({ json: { steps: [out("click", "Delete the account")] } });
    expect(await createReplanner(llm)!.replan(input({ remaining: [] }), call)).toMatchObject({ steps: null, reason: "action_blocked", issues: [expect.stringContaining("disabled")] });
  });

  it("a cancelled run is not swallowed", async () => {
    const { llm } = setup({ json: { steps: good } });
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(createReplanner(llm)!.replan(input(), { ...call, signal: controller.signal })).rejects.toThrow();
  });
});


it("refines unseen pages from visible sections without treating arrival as failure (KI-089, 2026-11-22)", () => {
  const prompt = buildReplanPrompt(input({ arrived: true }));
  expect(prompt).toContain("no step failed");
  expect(prompt).toContain("one separate Continue action per section");
  expect(prompt).toContain("every destructive action still ahead");
  expect(prompt).toContain("every pending checkpoint");
  expect(prompt).toContain(requirement.originalText);
  expect(prompt).toContain("The next step to refine");
});
