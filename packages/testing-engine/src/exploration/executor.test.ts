import {
  BrowserProviderError,
  CancelledError,
  ExplorationStepSchema,
  ModelProviderError,
  ObservedFactSchema,
  type CachedElement,
  type ElementRef,
  type ExplorationStep,
  type NormalizedRequirement,
  type ObservedFact,
  type PlannedStep,
  type StoredTestRunRequest,
  type TestPlan,
} from "@platform/contracts";
import {
  ExplorerSessionClosedError,
  NavigationBlockedError,
  type ActResult,
  type ExplorerSession,
  type NavigationBlock,
  type ObservedElement,
} from "@platform/stagehand-adapter/browser-explorer";
import { createRunRedactor } from "@platform/security";
import type { Page } from "playwright-core";
import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import type { EventDraft, StageContext } from "../orchestrator/stages";
import { runExploration, type ExplorationStore, type RecorderPort } from "./executor";
import type { FieldFacts, InputGenerator, InputRequest } from "./input-generator";
import type { CriterionJudge, JudgeRequest } from "./judge";
import { factFromReadings, type FactCaptureInput } from "./fact-reader";
import { observeCacheKey, type CacheWhere, type ObserveCache } from "./observe-cache";

// ---------------------------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------------------------

const SECRET = "Sup3r-Secret-Value!";
const TARGET = "https://shop.test/products/1";
const USAGE = { model: "fake-model", inputTokens: 100, outputTokens: 10, cacheHit: null };
const FIELD: FieldFacts = { tag: "input", type: "text", name: null, label: null, placeholder: null, autocomplete: null, maxLength: null, min: null, max: null, pattern: null, options: [] };

type Call = { op: "navigate" | "observe" | "act" | "actOn" | "extract" | "screenshot" | "close"; arg: unknown };

interface FakeSessionScript {
  navigate?: (url: string) => Promise<void> | void;
  observe?: (instruction: string, n: number) => Promise<ObservedElement[]> | ObservedElement[];
  actOn?: (el: ObservedElement, n: number) => Promise<Partial<ActResult>> | Partial<ActResult>;
  extract?: (instruction: string) => Promise<unknown> | unknown;
  waitForLoadState?: (state: string) => Promise<void> | void;
}

class FakeSession implements ExplorerSession {
  readonly calls: Call[] = [];
  closed = false;
  url = "about:blank";
  observeCount = 0;
  actOnCount = 0;
  /** `page.waitForLoadState` calls, as [state, timeout]. */
  readonly loadStates: [string, number | undefined][] = [];
  readonly page: Page;

  constructor(private readonly script: FakeSessionScript = {}) {
    const self = this;
    this.page = {
      url: () => self.url,
      isClosed: () => false,
      waitForLoadState: async (state: string, opts?: { timeout?: number }) => {
        self.loadStates.push([state, opts?.timeout]);
        await self.script.waitForLoadState?.(state);
      },
    } as unknown as Page;
  }

  async navigate(url: string) {
    this.calls.push({ op: "navigate", arg: url });
    await this.script.navigate?.(url);
    this.url = url;
    return { url };
  }

  async observe(instruction: string) {
    this.calls.push({ op: "observe", arg: instruction });
    const n = this.observeCount++;
    const elements = this.script.observe
      ? await this.script.observe(instruction, n)
      : [{ selector: `xpath=/html[1]/body[1]/el[${n + 1}]`, description: "an element", method: "click", arguments: [] }];
    return { elements, llm: USAGE };
  }

  async act(instruction: string): Promise<ActResult> {
    this.calls.push({ op: "act", arg: instruction });
    return { success: true, message: "done", element: null, navigationBlocks: [], llm: USAGE };
  }

  async actOn(element: ObservedElement): Promise<ActResult> {
    this.calls.push({ op: "actOn", arg: element });
    const n = this.actOnCount++;
    const res = (await this.script.actOn?.(element, n)) ?? {};
    return { success: true, message: "clicked", element, navigationBlocks: [], llm: null, ...res };
  }

  async extract<T>(instruction: string, schema: ZodType<T>) {
    this.calls.push({ op: "extract", arg: instruction });
    const data = schema.parse(await this.script.extract?.(instruction));
    return { data, llm: USAGE };
  }

  async screenshot(options?: { fullPage?: boolean }) {
    this.calls.push({ op: "screenshot", arg: options ?? null });
    return Buffer.from("\x89PNG fake");
  }

  async close() {
    this.calls.push({ op: "close", arg: null });
    this.closed = true;
  }

  ops() {
    return this.calls.map((c) => c.op);
  }
}

interface FakeRecorderOptions {
  /** Accessibility facts per selector (default: no role, named "Add to cart"; a field or a button only when a test says so). */
  describe?: (selector: string) => { role: string | null; name: string | null; text: string | null };
  /** DOM readings per fact key (default: equal to the model value). */
  dom?: Record<string, unknown>;
  /** Whether a selector matches exactly one element (default: every selector does). */
  unique?: (selector: string) => boolean;
  /** DOM readings per located element's selector (ahead of `dom`). */
  readings?: Record<string, unknown>;
}

function fakeRecorder(opts: FakeRecorderOptions = {}) {
  const fills: { selector: string; value: string }[] = [];
  const selects: { selector: string; value: string }[] = [];
  const captures: FactCaptureInput[] = [];
  const ref = (selector: string): ElementRef => ({ candidates: [{ strategy: "xpath", selector }], chosenIndex: 0, framePath: [] });
  const recorder: RecorderPort = {
    async describe(_page, selector) {
      return opts.describe?.(selector) ?? { role: null, name: "Add to cart", text: "Add to cart" };
    },
    async record(_page, selector) {
      if (opts.unique && !opts.unique(selector)) throw new Error("recorder: selector must match exactly one element (matched 0)");
      return ref(selector);
    },
    async fill(_page, selector, value) {
      fills.push({ selector, value });
    },
    async select(_page, selector, value) {
      selects.push({ selector, value });
    },
    async captureFact(_page, input) {
      captures.push(input);
      const at = input.element ? (input.element.candidates[0] as { selector?: string }).selector : undefined;
      const reading = at !== undefined && opts.readings && Object.hasOwn(opts.readings, at) ? opts.readings[at] : (opts.dom?.[input.key] ?? input.modelValue);
      const dom = input.element && input.mode ? { value: reading as never, read: { element: input.element, mode: input.mode } } : null;
      return factFromReadings({ key: input.key, checkpoint: input.checkpoint, stepId: input.stepId, modelValue: input.modelValue, dom });
    },
  };
  return { recorder, fills, selects, captures };
}

/** A search on the fake page: each attempt observes the field (el[1], el[3], …), then its Search button (el[2], …). */
const searchRoles = (selector: string) => {
  const n = Number(/el\[(\d+)\]$/.exec(selector)?.[1] ?? 0);
  return n % 2 === 1 ? { role: "searchbox", name: "Search products", text: null } : { role: "button", name: "Search", text: "Search" };
};

function memoryStore() {
  const steps: ExplorationStep[] = [];
  const facts: ObservedFact[] = [];
  const screenshots: { png: Buffer; sensitivity: string; fileName: string }[] = [];
  const store: ExplorationStore = {
    async saveStep(step) {
      steps.push(ExplorationStepSchema.parse(step));
    },
    async saveFact(fact) {
      facts.push(ObservedFactSchema.parse(fact));
    },
    async saveScreenshot(input) {
      screenshots.push(input);
      return { artifactId: `art_${screenshots.length}` };
    },
  };
  return { store, steps, facts, screenshots };
}

interface CtxOptions {
  options?: Partial<StoredTestRunRequest["options"]>;
  environment?: "staging" | "production";
  secrets?: Record<string, string>;
  testData?: Record<string, string | number | boolean | null>;
  targetUrl?: string;
}

function fakeCtx(o: CtxOptions = {}) {
  const run = new AbortController();
  const budget = new AbortController();
  const events: EventDraft[] = [];
  const cleanups: (() => unknown)[] = [];
  const secrets = o.secrets ?? {};
  // The run's redactor: key-based only; secret values are kept (2026-10-07).
  const redact = createRunRedactor();
  const ctx: StageContext = {
    runId: "run_exec",
    tenantId: "t_default",
    request: {
      targetUrl: o.targetUrl ?? TARGET,
      requirement: "Add iPhone 17 Pro to the cart; the cart count increases.",
      environment: o.environment ?? "staging",
      browser: "chromium",
      testData: o.testData ?? {},
      secretNames: Object.keys(secrets),
      options: {
        maxExplorationSteps: 40,
        maxRunSeconds: 300,
        generatePlaywright: true,
        rerunGeneratedTest: true,
        autoConfirmCriteria: true,
        allowDestructiveActions: false,
        additionalAllowedHosts: [],
        ...o.options,
      },
    },
    signal: run.signal,
    deadlineAt: null,
    budgets: { explorationMs: 60_000, rerunMs: 30_000 },
    secrets: { names: Object.keys(secrets), get: (n) => secrets[n] },
    redact,
    publish: async (e) => void events.push(e),
    addCleanup: (fn) => void cleanups.push(fn),
    boundary: async () => {
      if (run.signal.aborted) throw run.signal.reason;
    },
    budgetSignal: () => budget.signal,
    now: () => new Date("2026-09-26T10:00:00.000Z"),
    llm: null, // the executor makes no model call of its own (the explorer does, through the stage)
  };
  return { ctx, run, budget, events, cleanups };
}

let seq = 0;
const step = (kind: PlannedStep["kind"], description: string, extra: Partial<PlannedStep> = {}): PlannedStep => ({
  id: `PS-${++seq}`,
  kind,
  description,
  criterionIds: [],
  destructive: false,
  ...extra,
});

function planOf(...steps: PlannedStep[]): TestPlan {
  seq = 0;
  return {
    runId: "run_exec",
    requirementRevision: 1,
    scenarios: [{ id: "SC-1", title: "scenario", criterionIds: ["AC-1"], steps: steps.map((s, i) => ({ ...s, id: `PS-${i + 1}` })) }],
    blockedCriteria: [],
    stopConditions: [],
  };
}

function requirementWith(facts: NormalizedRequirement["facts"], outcome?: NormalizedRequirement["criteria"][number]["expectedOutcome"]): NormalizedRequirement {
  return {
    runId: "run_exec",
    revision: 1,
    originalText: "Add iPhone 17 Pro to the cart; the cart count increases.",
    criteria: [
      {
        id: "AC-1",
        sourceText: "the cart count increases",
        statement: "The cart count increases",
        expectedOutcome: outcome ?? { kind: "semantic", description: "the cart count increases" },
        preconditions: [],
        critical: true,
        ambiguity: null,
      },
    ],
    facts,
    confirmedAt: "2026-09-26T09:59:00.000Z",
  };
}

const cartFact = { key: "cartCount", checkpoint: "after_add", description: "Cart badge count", valueType: "number" as const };

const summary = (steps: ExplorationStep[]) =>
  steps.map((s) => [s.index, s.kind, s.plannedStepId, s.outcome, s.onGoldenPath]);

// ---------------------------------------------------------------------------------------------

describe("runExploration (fake explorer)", () => {
  it("navigate → observe → act (one retry) → extract { cartCount: 1 }: steps persisted in order, golden path only on successful planned executions", async () => {
    const { ctx, events } = fakeCtx();
    const session = new FakeSession({
      actOn: (_el, n) => (n === 0 ? { success: false, message: "element detached" } : {}),
      extract: () => ({ cartCount: 1 }),
    });
    const { recorder, captures } = fakeRecorder();
    const mem = memoryStore();
    const plan = planOf(
      step("navigate", "Open the product page"),
      step("click", "Click Add to cart"),
      step("capture_checkpoint", "Capture the cart badge after adding", { checkpoint: "after_add" }),
    );

    const outcome = await runExploration(ctx, { plan, requirement: requirementWith([cartFact]), session, budget: ctx.budgetSignal(1) }, { store: mem.store, recorder });

    expect(outcome.stopReason).toBe("COMPLETED");
    expect(summary(outcome.steps)).toEqual([
      [0, "navigate", "PS-1", "SUCCESS", true],
      [1, "observe", "PS-2", "SUCCESS", false],
      [2, "act", "PS-2", "FAILED", false], // failed attempt
      [3, "observe", "PS-2", "SUCCESS", false], // retry
      [4, "act", "PS-2", "SUCCESS", true],
      [5, "extract", "PS-3", "SUCCESS", false],
      [6, "observe", "PS-3", "SUCCESS", false], // locating the badge
      [7, "checkpoint", "PS-3", "SUCCESS", true],
    ]);
    // Persisted in the same order, before the outcome returned.
    expect(mem.steps.map((s) => s.id)).toEqual(outcome.steps.map((s) => s.id));
    expect(session.calls[0]).toEqual({ op: "navigate", arg: TARGET }); // first action: the target URL
    expect(session.ops()).not.toContain("act"); // clicks replay the observed element (no model-chosen action)

    const [nav, , failed, , acted, extracted, , checkpoint] = outcome.steps as ExplorationStep[];
    expect(nav).toMatchObject({ urlBefore: "about:blank", urlAfter: TARGET, element: null, llm: null });
    expect(failed).toMatchObject({ error: expect.stringContaining("element detached"), element: { chosenIndex: 0 } });
    expect(acted!.element).not.toBeNull();
    expect(acted!.llm).toBeNull(); // actOn makes no model call
    expect(outcome.steps[1]!.llm).toEqual(USAGE); // observe usage (R21: cacheHit null)
    expect(extracted!.llm).toEqual(USAGE);
    expect(checkpoint!.artifactIds).toEqual(["art_1"]);

    // Facts: the reserved url fact first, then cartCount read from the DOM at the located element.
    expect(outcome.facts.map((f) => [f.key, f.checkpoint, f.value, f.provenance, f.stepId])).toEqual([
      ["url", "after_add", TARGET, "DOM_VERIFIED", checkpoint!.id],
      ["cartCount", "after_add", 1, "DOM_VERIFIED", checkpoint!.id],
    ]);
    expect(captures[0]).toMatchObject({ key: "cartCount", modelValue: 1, mode: "number" });
    expect(mem.facts).toEqual(outcome.facts);
    expect(mem.screenshots).toMatchObject([{ sensitivity: "STANDARD", fileName: "after_add.png" }]);
    expect(session.calls.filter((c) => c.op === "screenshot").map((c) => c.arg)).toEqual([{ fullPage: true }]); // V1.3: the whole page

    // Events: one step.recorded per step, fact.observed per fact (no value), artifact.created (no URL).
    expect(events.filter((e) => e.type === "step.recorded")).toHaveLength(8);
    expect(events.filter((e) => e.type === "fact.observed").map((e) => e.payload)).toEqual([
      { key: "url", checkpoint: "after_add", provenance: "DOM_VERIFIED" },
      { key: "cartCount", checkpoint: "after_add", provenance: "DOM_VERIFIED" },
    ]);
    expect(events.filter((e) => e.type === "artifact.created").map((e) => e.payload)).toEqual([
      { artifactId: "art_1", type: "SCREENSHOT", sensitivity: "STANDARD" },
    ]);
    expect(events.find((e) => e.type === "step.recorded")).toMatchObject({
      message: "Step 1: navigate succeeded",
      payload: { stepId: nav!.id, index: 0, kind: "navigate", outcome: "SUCCESS", blockReason: null },
    });
    expect(session.closed).toBe(true);
  });

  it("maxExplorationSteps = 3, objective never met → stops after 3 steps with STEP_LIMIT_REACHED", async () => {
    const { ctx } = fakeCtx({ options: { maxExplorationSteps: 3 } });
    const session = new FakeSession();
    const mem = memoryStore();
    const plan = planOf(
      step("navigate", "Open the product page"),
      step("click", "Click Add to cart"),
      step("click", "Click Add to cart again"),
      step("capture_checkpoint", "Capture", { checkpoint: "after_add" }),
    );

    const outcome = await runExploration(ctx, { plan, requirement: requirementWith([cartFact]), session, budget: ctx.budgetSignal(1) }, { store: mem.store, recorder: fakeRecorder().recorder });

    expect(outcome.stopReason).toBe("STEP_LIMIT_REACHED");
    expect(outcome.steps).toHaveLength(3);
    expect(mem.steps).toHaveLength(3);
    expect(session.ops()).toEqual(["navigate", "observe", "actOn", "close"]); // nothing ran that couldn't be recorded
    expect(outcome.facts).toEqual([]);
  });

  it("exploration budget exhausted mid-operation → returns EXPLORATION_BUDGET_EXHAUSTED (does not throw), session closed", async () => {
    const { ctx, budget } = fakeCtx();
    const session = new FakeSession({
      observe: (_i, n) => {
        if (n === 1) {
          // The real session races every operation against its (budget) signal.
          budget.abort(new DOMException("The operation timed out.", "TimeoutError"));
          throw budget.signal.reason;
        }
        return [{ selector: "xpath=/html[1]/body[1]/button[1]", description: "button", method: "click", arguments: [] }];
      },
    });
    const mem = memoryStore();
    const plan = planOf(step("navigate", "Open the product page"), step("click", "Click Add to cart"), step("click", "Click Add to cart again"));

    const outcome = await runExploration(ctx, { plan, requirement: requirementWith([]), session, budget: ctx.budgetSignal(1) }, { store: mem.store, recorder: fakeRecorder().recorder });

    expect(outcome.stopReason).toBe("EXPLORATION_BUDGET_EXHAUSTED");
    expect(summary(outcome.steps)).toEqual([
      [0, "navigate", "PS-1", "SUCCESS", true],
      [1, "observe", "PS-2", "SUCCESS", false],
      [2, "act", "PS-2", "SUCCESS", true],
    ]);
    expect(session.closed).toBe(true);
  });

  it("an already exhausted budget stops before the first action", async () => {
    const { ctx, budget } = fakeCtx();
    budget.abort(new DOMException("The operation timed out.", "TimeoutError"));
    const session = new FakeSession();
    const outcome = await runExploration(ctx, { plan: planOf(step("navigate", "Open")), requirement: requirementWith([]), session, budget: ctx.budgetSignal(1) }, { store: memoryStore().store, recorder: fakeRecorder().recorder });
    expect(outcome).toEqual({ steps: [], facts: [], stopReason: "EXPLORATION_BUDGET_EXHAUSTED" });
    expect(session.ops()).toEqual(["close"]);
  });

  it("secrets: a fill step with a secret inputRef is filled by the recorder, never by act(); the value is no longer redacted from rows and events", async () => {
    const { ctx, events } = fakeCtx({ secrets: { password: SECRET }, testData: { email: "qa@demo.test" }, targetUrl: "https://shop.test/" });
    const session = new FakeSession({
      observe: (instruction, n) => [{ selector: `xpath=/html[1]/body[1]/f[${n + 1}]`, description: `field for ${instruction}`, method: "fill", arguments: ["model-chosen"] }],
      // The page echoes the secret after login; the model reads it back.
      extract: () => ({ greeting: `Welcome back, ${SECRET}` }),
      actOn: () => ({ message: `logged in with ${SECRET}` }),
    });
    const { recorder, fills } = fakeRecorder({
      // f[1] and f[2] are the email and password fields, f[3] the Log in button.
      describe: (selector) => (/f\[[12]\]$/.test(selector) ? { role: "textbox", name: "Email or password", text: null } : { role: "button", name: "Log in", text: `Log in ${SECRET}` }),
      dom: { greeting: `Welcome back, ${SECRET}` },
    });
    const mem = memoryStore();
    const plan = planOf(
      step("navigate", "Open https://shop.test/login"),
      step("fill", "Fill the email field", { inputRef: { source: "testData", key: "email" } }),
      step("fill", "Fill the password field", { inputRef: { source: "secret", key: "password" } }),
      // A description that contains the value keeps it (secrets are not redacted since 2026-10-07).
      step("login", `Click the Log in button, not the one labelled ${SECRET}`),
      step("capture_checkpoint", "Capture the greeting", { checkpoint: "after_login" }),
    );
    const requirement = requirementWith([{ key: "greeting", checkpoint: "after_login", description: "Greeting text", valueType: "string" }]);

    const outcome = await runExploration(ctx, { plan, requirement, session, budget: ctx.budgetSignal(1) }, { store: mem.store, recorder });

    expect(outcome.stopReason).toBe("COMPLETED");
    // Our code filled both fields with the resolved values.
    expect(fills.map((f) => f.value)).toEqual(["qa@demo.test", SECRET]);
    // The model never acted with a value: no act(), and actOn only for the login click, with no arguments.
    expect(session.ops()).not.toContain("act");
    const actOns = session.calls.filter((c) => c.op === "actOn").map((c) => c.arg as ObservedElement);
    expect(actOns).toHaveLength(1);
    expect(actOns[0]).toMatchObject({ method: "click", arguments: [] });

    const fillSteps = outcome.steps.filter((s) => s.kind === "fill");
    expect(fillSteps.map((s) => [s.plannedStepId, s.inputRef, s.onGoldenPath, s.outcome])).toEqual([
      ["PS-2", { source: "testData", key: "email" }, true, "SUCCESS"],
      ["PS-3", { source: "secret", key: "password" }, true, "SUCCESS"],
    ]);
    expect(outcome.steps.find((s) => s.plannedStepId === "PS-4" && s.onGoldenPath)).toMatchObject({ kind: "act", instruction: expect.stringContaining(SECRET) });
    expect(mem.screenshots.map((s) => s.sensitivity)).toEqual(["STANDARD"]);
    expect(events.find((e) => e.type === "artifact.created")?.payload).toMatchObject({ sensitivity: "STANDARD" });
    expect(JSON.stringify(mem.facts)).toContain(SECRET);
  });

  it("a full-page screenshot that fails falls back to the viewport; neither → artifact.omitted, the step still recorded", async () => {
    const { ctx, events } = fakeCtx();
    const plan = planOf(step("navigate", "Open the account page"), step("click", "Click the big red button", { destructive: true }));
    const run = async (fail: (o?: { fullPage?: boolean }) => boolean) => {
      const session = new FakeSession();
      const shoot = session.screenshot.bind(session);
      session.screenshot = async (o) => {
        const png = await shoot(o);
        if (fail(o)) throw new Error("Protocol error: Page.captureScreenshot");
        return png;
      };
      const mem = memoryStore();
      const outcome = await runExploration(ctx, { plan, requirement: requirementWith([]), session, budget: ctx.budgetSignal(1) }, { store: mem.store, recorder: fakeRecorder().recorder });
      return { outcome, mem, session };
    };

    const fallback = await run((o) => o?.fullPage === true);
    expect(fallback.session.calls.filter((c) => c.op === "screenshot").map((c) => c.arg)).toEqual([{ fullPage: true }, { fullPage: false }]);
    expect(fallback.outcome.steps.at(-1)!.artifactIds).toEqual(["art_1"]);

    const none = await run(() => true);
    expect(none.outcome.steps.at(-1)).toMatchObject({ outcome: "BLOCKED_BY_POLICY", artifactIds: [] });
    expect(none.mem.screenshots).toEqual([]);
    expect(events.filter((e) => e.type === "artifact.omitted").at(-1)?.message).toBe("Screenshot where exploration was blocked could not be taken");
  });

  it.each(["secret", "testData"] as const)(
    "a %s inputRef nobody provided is generated from its field once it is located, filled, and recorded on the step",
    async (source) => {
      const { ctx } = fakeCtx();
      const session = new FakeSession({
        observe: (instruction, n) => [{ selector: `xpath=/html[1]/body[1]/f[${n + 1}]`, description: `field for ${instruction}`, method: "fill", arguments: [] }],
      });
      const { recorder, fills } = fakeRecorder({ describe: (sel) => (/f\[1\]$/.test(sel) ? { role: "textbox", name: "Password", text: null } : { role: "button", name: "Log in", text: "Log in" }) });
      const fields: string[] = [];
      recorder.describeField = async (_page, selector) => (fields.push(selector), { ...FIELD, type: "password", label: "Password" });
      const requests: InputRequest[] = [];
      const inputs: InputGenerator = { generate: async (req) => (requests.push(req), { value: "Gen-Pass-1!aB", llm: USAGE }) };
      const plan = planOf(
        step("navigate", "Open the login page"),
        step("fill", "Fill the password field", { inputRef: { source, key: "password" } }),
        step("login", "Click Log in"),
      );
      const mem = memoryStore();
      const outcome = await runExploration(ctx, { plan, requirement: requirementWith([]), session, budget: ctx.budgetSignal(1) }, { store: mem.store, recorder, inputs });

      expect(outcome.stopReason).toBe("COMPLETED");
      expect(fills).toEqual([{ selector: "xpath=/html[1]/body[1]/f[1]", value: "Gen-Pass-1!aB" }]);
      expect(fields).toEqual(["xpath=/html[1]/body[1]/f[1]"]);
      expect(requests).toMatchObject([{ source, key: "password", stepDescription: "Fill the password field", field: { type: "password", label: "Password" } }]);
      expect(outcome.steps.find((s) => s.kind === "fill")).toMatchObject({ outcome: "SUCCESS", onGoldenPath: true, inputRef: { source, key: "password" }, generatedValue: "Gen-Pass-1!aB", llm: USAGE });
      expect(outcome.steps.some((s) => s.outcome === "BLOCKED_BY_POLICY")).toBe(false);
    },
  );

  it("a generated value is made once per key and reused by a later fill of it, in another scenario too; a provided value is not generated", async () => {
    const { ctx } = fakeCtx({ testData: { email: "qa@demo.test" } });
    const session = new FakeSession({
      observe: (instruction, n) => [{ selector: `xpath=/html[1]/body[1]/f[${n + 1}]`, description: `field for ${instruction}`, method: "fill", arguments: [] }],
    });
    const { recorder, fills } = fakeRecorder({ describe: () => ({ role: "textbox", name: "Field", text: null }) });
    let calls = 0;
    const inputs: InputGenerator = { generate: async () => ({ value: `generated-${++calls}`, llm: null }) };
    const signUp = [step("navigate", "Open sign up"), step("fill", "Fill the email", { inputRef: { source: "testData", key: "email" } }), step("fill", "Choose a password", { inputRef: { source: "secret", key: "password" } })];
    const logIn = [step("navigate", "Open log in"), step("fill", "Fill the password", { inputRef: { source: "secret", key: "password" } })];
    const plan: TestPlan = { ...planOf(...signUp), scenarios: [
      { id: "SC-1", title: "Sign up", criterionIds: [], steps: signUp },
      { id: "SC-2", title: "Log in", criterionIds: [], steps: logIn },
    ] };
    const outcome = await runExploration(ctx, { plan, requirement: requirementWith([]), session, budget: ctx.budgetSignal(1) }, { store: memoryStore().store, recorder, inputs, resetSession: async () => {} });

    expect(calls).toBe(1);
    expect(fills.map((f) => f.value)).toEqual(["qa@demo.test", "generated-1", "generated-1"]);
    expect(outcome.steps.filter((s) => s.kind === "fill").map((s) => s.generatedValue ?? null)).toEqual([null, "generated-1", "generated-1"]);
  });

  it("a failed fill with an empty value keeps the error text readable", async () => {
    const { ctx } = fakeCtx({ testData: { note: "" } });
    const session = new FakeSession({
      observe: () => [{ selector: "xpath=/html[1]/body[1]/textarea[1]", description: "note field", method: "fill", arguments: [] }],
    });
    const { recorder } = fakeRecorder();
    recorder.fill = async () => {
      throw new Error("element is detached");
    };
    const plan = planOf(step("navigate", "Open"), step("fill", "Fill the note field", { inputRef: { source: "testData", key: "note" } }));
    const outcome = await runExploration(ctx, { plan, requirement: requirementWith([]), session, budget: ctx.budgetSignal(1) }, { store: memoryStore().store, recorder });

    const failed = outcome.steps.find((s) => s.kind === "fill" && s.outcome === "FAILED");
    expect(failed?.error).toBe("element is detached");
  });

  it("every navigation waits for a quiet network (bounded); a page that never goes quiet is not an error", async () => {
    const { ctx } = fakeCtx();
    const session = new FakeSession({
      waitForLoadState: (state) => {
        if (state === "networkidle") throw new Error("Timeout 3000ms exceeded.");
      },
    });
    const plan = planOf(step("navigate", "Open the product page"), step("navigate", "Open https://shop.test/cart"));
    const outcome = await runExploration(ctx, { plan, requirement: requirementWith([]), session, budget: ctx.budgetSignal(1) }, { store: memoryStore().store, recorder: fakeRecorder().recorder });

    expect(outcome.stopReason).toBe("COMPLETED");
    expect(summary(outcome.steps)).toEqual([
      [0, "navigate", "PS-1", "SUCCESS", true],
      [1, "navigate", "PS-2", "SUCCESS", true],
    ]);
    expect(session.loadStates).toEqual([
      ["networkidle", 3_000],
      ["networkidle", 3_000],
    ]);
  });

  it("a value the page cleared after it was typed (a form that resets while the page starts up) is typed again before the next click", async () => {
    const { ctx } = fakeCtx({ testData: { firstName: "John", lastName: "Doe" } });
    const session = new FakeSession({
      observe: (instruction, n) => [{ selector: `xpath=/html[1]/body[1]/f[${n + 1}]`, description: `element for ${instruction}`, method: "fill", arguments: [] }],
    });
    const { recorder, fills } = fakeRecorder({
      describe: (selector) => (/f\[3\]$/.test(selector) ? { role: "button", name: "Register", text: "Register" } : { role: "textbox", name: "Name", text: null }),
    });
    // The page empties the first name once, after the last name was typed.
    const page = new Map<string, string>();
    recorder.fill = async (_page, selector, value) => {
      fills.push({ selector, value });
      page.set(selector, value);
      if (/f\[2\]$/.test(selector)) page.set("xpath=/html[1]/body[1]/f[1]", "");
    };
    recorder.value = async (_page, selector) => page.get(selector) ?? null;
    const plan = planOf(
      step("navigate", "Open the register page"),
      step("fill", "Fill in the first name", { inputRef: { source: "testData", key: "firstName" } }),
      step("fill", "Fill in the last name", { inputRef: { source: "testData", key: "lastName" } }),
      step("submit", "Click the register button"),
    );
    const outcome = await runExploration(ctx, { plan, requirement: requirementWith([]), session, budget: ctx.budgetSignal(1) }, { store: memoryStore().store, recorder });

    expect(outcome.stopReason).toBe("COMPLETED");
    expect(fills.map((f) => f.value)).toEqual(["John", "Doe", "John"]);
    expect(outcome.steps.filter((s) => s.kind !== "observe").map((s) => [s.kind, s.plannedStepId, s.outcome, s.onGoldenPath, s.instruction])).toEqual([
      ["navigate", "PS-1", "SUCCESS", true, "Navigate to https://shop.test/products/1"],
      ["fill", "PS-2", "SUCCESS", true, "Fill in the first name"],
      ["fill", "PS-3", "SUCCESS", true, "Fill in the last name"],
      ["fill", "PS-2", "SUCCESS", true, "Fill again, the page cleared it: Fill in the first name"],
      ["act", "PS-4", "SUCCESS", true, "Click the register button"],
    ]);
    const [, first, , again] = outcome.steps.filter((s) => s.kind !== "observe");
    expect(again).toMatchObject({ element: first!.element, inputRef: { source: "testData", key: "firstName" } });
  });

  it("only a field left empty is typed again: a reformatted value, a field that is gone, a selection and values typed before an earlier click are left alone", async () => {
    const { ctx } = fakeCtx({ testData: { phone: "5551234", city: "Hanoi", country: "VN" } });
    const session = new FakeSession({
      observe: (instruction, n) => [{ selector: `xpath=/html[1]/body[1]/f[${n + 1}]`, description: `element for ${instruction}`, method: "fill", arguments: [] }],
    });
    const { recorder, fills, selects } = fakeRecorder({
      describe: (selector) => (/f\[[45]\]$/.test(selector) ? { role: "button", name: "Next", text: "Next" } : { role: "textbox", name: "Field", text: null }),
    });
    const reads: string[] = [];
    // f[1] phone: reformatted by the page; f[2] city: gone; f[3] country: a select (never read); f[4], f[5]: the buttons.
    recorder.value = async (_page, selector) => {
      reads.push(selector);
      return { "xpath=/html[1]/body[1]/f[1]": "(555) 1234", "xpath=/html[1]/body[1]/f[3]": "" }[selector] ?? null;
    };
    const plan = planOf(
      step("navigate", "Open the address form"),
      step("fill", "Fill the phone", { inputRef: { source: "testData", key: "phone" } }),
      step("fill", "Fill the city", { inputRef: { source: "testData", key: "city" } }),
      step("select", "Choose the country", { inputRef: { source: "testData", key: "country" } }),
      step("click", "Click Next"),
      step("click", "Click Next again"),
    );
    const outcome = await runExploration(ctx, { plan, requirement: requirementWith([]), session, budget: ctx.budgetSignal(1) }, { store: memoryStore().store, recorder });

    expect(outcome.stopReason).toBe("COMPLETED");
    expect(fills.map((f) => f.value)).toEqual(["5551234", "Hanoi"]);
    expect(selects.map((f) => f.value)).toEqual(["VN"]);
    // Read before the first click only: the phone and the city, never the select.
    expect(reads).toEqual(["xpath=/html[1]/body[1]/f[1]", "xpath=/html[1]/body[1]/f[2]"]);
  });

  it("an action denied by assertActionAllowed (observed element's role/name/text) → BLOCKED_BY_POLICY, not executed, exploration stops", async () => {
    const { ctx, events } = fakeCtx();
    const session = new FakeSession({ extract: () => ({ cartCount: 0 }) });
    const { recorder } = fakeRecorder({ describe: () => ({ role: "button", name: "Delete account", text: "Delete account" }) });
    const plan = planOf(
      step("navigate", "Open the account page"),
      step("click", "Click the red button in the danger zone"), // harmless wording; the element is not
      step("capture_checkpoint", "Capture", { checkpoint: "after_add" }),
    );

    const outcome = await runExploration(ctx, { plan, requirement: requirementWith([cartFact]), session, budget: ctx.budgetSignal(1) }, { store: memoryStore().store, recorder });

    expect(outcome.stopReason).toBe("BLOCKED_BY_POLICY");
    expect(summary(outcome.steps)).toEqual([
      [0, "navigate", "PS-1", "SUCCESS", true],
      [1, "observe", "PS-2", "SUCCESS", false],
      [2, "act", "PS-2", "BLOCKED_BY_POLICY", false],
    ]);
    expect(outcome.steps[2]).toMatchObject({ blockReason: "DESTRUCTIVE_ACTION_NOT_AUTHORIZED", element: { chosenIndex: 0 } });
    expect(session.ops()).toEqual(["navigate", "observe", "screenshot", "close"]); // never acted, never extracted
    expect(events.filter((e) => e.type === "step.recorded").at(-1)?.payload).toMatchObject({ outcome: "BLOCKED_BY_POLICY", blockReason: "DESTRUCTIVE_ACTION_NOT_AUTHORIZED" });
  });

  it.each([
    ["off in staging", { allowDestructiveActions: false }, "staging", true],
    ["allowed in staging", { allowDestructiveActions: true }, "staging", false],
    ["production without a confirmed host", { allowDestructiveActions: true }, "production", true],
    ["production with the host confirmed", { allowDestructiveActions: true, confirmProductionHost: new URL(TARGET).host }, "production", false],
  ] as const)("destructive policy: %s → blocked=%s (a step worded as destructive)", async (_name, options, environment, blocked) => {
    const { ctx } = fakeCtx({ options, environment });
    const session = new FakeSession();
    const { recorder } = fakeRecorder({ describe: () => ({ role: "button", name: "Delete account", text: null }) });
    const plan = planOf(step("navigate", "Open"), step("click", "Click the Delete account button"));
    const outcome = await runExploration(ctx, { plan, requirement: requirementWith([]), session, budget: ctx.budgetSignal(1) }, { store: memoryStore().store, recorder });
    expect(outcome.stopReason).toBe(blocked ? "BLOCKED_BY_POLICY" : "COMPLETED");
    expect(session.ops().includes("actOn")).toBe(!blocked);
  });

  it("with destructive actions allowed, a destructive element on a step the plan does not mark destructive is blocked", async () => {
    const { ctx } = fakeCtx({ options: { allowDestructiveActions: true } });
    const session = new FakeSession();
    const { recorder } = fakeRecorder({ describe: () => ({ role: "button", name: "Delete account", text: "Delete account" }) });
    const plan = planOf(step("navigate", "Open"), step("click", "Click the button in the danger zone"));
    const outcome = await runExploration(ctx, { plan, requirement: requirementWith([]), session, budget: ctx.budgetSignal(1) }, { store: memoryStore().store, recorder });
    expect(outcome.stopReason).toBe("BLOCKED_BY_POLICY");
    expect(outcome.steps.at(-1)).toMatchObject({
      outcome: "BLOCKED_BY_POLICY",
      blockReason: "DESTRUCTIVE_ACTION_NOT_AUTHORIZED",
      error: "The element is destructive but the planned step is not",
    });
    expect(session.ops()).not.toContain("actOn");
  });

  it("with destructive actions allowed, a step the planner flagged destructive acts on the destructive element", async () => {
    const { ctx } = fakeCtx({ options: { allowDestructiveActions: true } });
    const session = new FakeSession();
    const { recorder } = fakeRecorder({ describe: () => ({ role: "button", name: "Delete account", text: null }) });
    const plan = planOf(step("navigate", "Open"), step("click", "Press the red button", { destructive: true }));
    const outcome = await runExploration(ctx, { plan, requirement: requirementWith([]), session, budget: ctx.budgetSignal(1) }, { store: memoryStore().store, recorder });
    expect(outcome.stopReason).toBe("COMPLETED");
    expect(session.ops()).toContain("actOn");
  });

  it("a planned step the planner marked destructive is blocked under the default policy even if no term matches", async () => {
    const { ctx } = fakeCtx();
    const session = new FakeSession();
    const plan = planOf(step("navigate", "Open"), step("click", "Click the big red button", { destructive: true }));
    const outcome = await runExploration(ctx, { plan, requirement: requirementWith([]), session, budget: ctx.budgetSignal(1) }, { store: memoryStore().store, recorder: fakeRecorder().recorder });
    expect(outcome.steps.at(-1)).toMatchObject({ outcome: "BLOCKED_BY_POLICY", blockReason: "DESTRUCTIVE_ACTION_NOT_AUTHORIZED" });
    expect(session.ops()).not.toContain("actOn");
  });

  it("with destructive actions allowed, a destructive step whose actOn reports failure is never retried (a dispatched click must not repeat)", async () => {
    const { ctx } = fakeCtx({ options: { allowDestructiveActions: true } });
    const session = new FakeSession({ actOn: () => ({ success: false, message: "payment gateway timed out" }) });
    const { recorder } = fakeRecorder();
    const plan = planOf(
      step("navigate", "Open"),
      step("click", "Click Pay now", { destructive: true }),
      step("capture_checkpoint", "Capture", { checkpoint: "after_pay" }),
    );
    const outcome = await runExploration(ctx, { plan, requirement: requirementWith([]), session, budget: ctx.budgetSignal(1) }, { store: memoryStore().store, recorder });

    expect(session.actOnCount).toBe(1);
    expect(outcome.steps.find((s) => s.kind === "act" && s.plannedStepId === "PS-2")).toMatchObject({
      outcome: "FAILED",
      error: expect.stringContaining("payment gateway timed out"),
    });
    expect(outcome.steps.some((s) => s.plannedStepId === "PS-3")).toBe(false); // exploration stopped before the checkpoint
  });

  it("the same actOn failure on a non-destructive step still retries (two actOn calls) — unchanged", async () => {
    const { ctx } = fakeCtx({ options: { allowDestructiveActions: true } });
    const session = new FakeSession({ actOn: () => ({ success: false, message: "element detached" }) });
    const { recorder } = fakeRecorder();
    const plan = planOf(step("navigate", "Open"), step("click", "Click Add to cart"));
    const outcome = await runExploration(ctx, { plan, requirement: requirementWith([]), session, budget: ctx.budgetSignal(1) }, { store: memoryStore().store, recorder });

    expect(session.actOnCount).toBe(2);
    expect(outcome.steps.filter((s) => s.kind === "act" && s.outcome === "FAILED")).toHaveLength(2);
  });

  it("a navigation blocked by the sandbox guard → BLOCKED_BY_POLICY with the guard's reason", async () => {
    const { ctx } = fakeCtx();
    const session = new FakeSession({
      navigate: (url) => {
        if (url.includes("evil.test")) throw new NavigationBlockedError(url, "OFF_DOMAIN_NAVIGATION");
      },
    });
    const plan = planOf(step("navigate", "Open the product page"), step("navigate", "Go to https://evil.test/x"), step("click", "Click Add to cart"));
    const outcome = await runExploration(ctx, { plan, requirement: requirementWith([]), session, budget: ctx.budgetSignal(1) }, { store: memoryStore().store, recorder: fakeRecorder().recorder });
    expect(outcome.stopReason).toBe("BLOCKED_BY_POLICY");
    expect(outcome.steps.at(-1)).toMatchObject({ kind: "navigate", plannedStepId: "PS-2", outcome: "BLOCKED_BY_POLICY", blockReason: "OFF_DOMAIN_NAVIGATION" });
    expect(session.ops()).toEqual(["navigate", "navigate", "screenshot", "close"]);
  });

  it("an action whose navigation the guard blocked → BLOCKED_BY_POLICY", async () => {
    const { ctx } = fakeCtx();
    const block: NavigationBlock = { url: "http://10.0.0.1/", reason: "TARGET_BLOCKED_BY_POLICY" };
    const session = new FakeSession({ actOn: () => ({ navigationBlocks: [block] }) });
    const plan = planOf(step("navigate", "Open"), step("click", "Click the partner link"), step("click", "Click Add to cart"));
    const outcome = await runExploration(ctx, { plan, requirement: requirementWith([]), session, budget: ctx.budgetSignal(1) }, { store: memoryStore().store, recorder: fakeRecorder().recorder });
    expect(outcome.stopReason).toBe("BLOCKED_BY_POLICY");
    expect(outcome.steps.at(-1)).toMatchObject({ kind: "act", outcome: "BLOCKED_BY_POLICY", blockReason: "TARGET_BLOCKED_BY_POLICY" });
    expect(session.actOnCount).toBe(1);
  });

  it("abort signal between steps → executor throws the abort reason, stops, session closed", async () => {
    const { ctx, run } = fakeCtx();
    const session = new FakeSession({
      actOn: () => {
        run.abort(new CancelledError());
        return {};
      },
    });
    const plan = planOf(step("navigate", "Open"), step("click", "Click Add to cart"), step("click", "Click again"));
    await expect(
      runExploration(ctx, { plan, requirement: requirementWith([]), session, budget: ctx.budgetSignal(1) }, { store: memoryStore().store, recorder: fakeRecorder().recorder }),
    ).rejects.toBeInstanceOf(CancelledError);
    expect(session.actOnCount).toBe(1);
    expect(session.ops().at(-1)).toBe("close");
    expect(session.closed).toBe(true);
  });

  it("a planned step that fails after one retry stops exploration (no later checkpoint: no fabricated evidence)", async () => {
    const { ctx } = fakeCtx();
    const session = new FakeSession({ observe: () => [] });
    const plan = planOf(step("navigate", "Open"), step("click", "Click Add to cart"), step("capture_checkpoint", "Capture", { checkpoint: "after_add" }));
    const outcome = await runExploration(ctx, { plan, requirement: requirementWith([cartFact]), session, budget: ctx.budgetSignal(1) }, { store: memoryStore().store, recorder: fakeRecorder().recorder });
    expect(outcome.stopReason).toBe("COMPLETED");
    // Each attempt: the element, then the way to it (KI-001); nothing found either time.
    expect(summary(outcome.steps)).toEqual([
      [0, "navigate", "PS-1", "SUCCESS", true],
      [1, "observe", "PS-2", "FAILED", false],
      [2, "observe", "PS-2", "FAILED", false],
      [3, "observe", "PS-2", "FAILED", false],
      [4, "observe", "PS-2", "FAILED", false],
    ]);
    expect(outcome.facts).toEqual([]);
    expect(session.ops()).not.toContain("extract");
  });

  it("model provider errors are infrastructure errors: rethrown (ERRORED), session closed", async () => {
    const { ctx } = fakeCtx();
    const session = new FakeSession({
      observe: () => {
        throw new ModelProviderError("provider down");
      },
    });
    await expect(
      runExploration(ctx, { plan: planOf(step("navigate", "Open"), step("click", "Click")), requirement: requirementWith([]), session, budget: ctx.budgetSignal(1) }, { store: memoryStore().store, recorder: fakeRecorder().recorder }),
    ).rejects.toBeInstanceOf(ModelProviderError);
    expect(session.closed).toBe(true);
  });

  it("a session closed under the executor is a BROWSER_PROVIDER error, not a step failure", async () => {
    const { ctx } = fakeCtx();
    const session = new FakeSession({
      observe: () => {
        throw new ExplorerSessionClosedError("explorer session is closed");
      },
    });
    const err = await runExploration(ctx, { plan: planOf(step("navigate", "Open"), step("click", "Click")), requirement: requirementWith([]), session, budget: ctx.budgetSignal(1) }, { store: memoryStore().store, recorder: fakeRecorder().recorder }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrowserProviderError);
    expect((err as BrowserProviderError).category).toBe("BROWSER_PROVIDER");
  });

  it("navigate with a URL uses session.navigate; without one it clicks the described link", async () => {
    const { ctx } = fakeCtx({ targetUrl: "https://shop.test/" });
    const session = new FakeSession();
    const plan = planOf(step("navigate", "Open https://shop.test/"), step("navigate", "Open the cart page"), step("navigate", "Go to /products/2"));
    const outcome = await runExploration(ctx, { plan, requirement: requirementWith([]), session, budget: ctx.budgetSignal(1) }, { store: memoryStore().store, recorder: fakeRecorder({ describe: () => ({ role: "link", name: "Cart", text: "Cart" }) }).recorder });
    expect(summary(outcome.steps)).toEqual([
      [0, "navigate", "PS-1", "SUCCESS", true], // the initial navigation is PS-1
      [1, "observe", "PS-2", "SUCCESS", false],
      [2, "act", "PS-2", "SUCCESS", true],
      [3, "navigate", "PS-3", "SUCCESS", true],
    ]);
    expect(session.calls.filter((c) => c.op === "navigate").map((c) => c.arg)).toEqual(["https://shop.test/", "https://shop.test/products/2"]);
  });

  it("the initial navigation to the target is its own step when the first planned step is not a plain navigation", async () => {
    const { ctx } = fakeCtx();
    const session = new FakeSession();
    const outcome = await runExploration(ctx, { plan: planOf(step("click", "Click Add to cart")), requirement: requirementWith([]), session, budget: ctx.budgetSignal(1) }, { store: memoryStore().store, recorder: fakeRecorder().recorder });
    expect(summary(outcome.steps)).toEqual([
      [0, "navigate", null, "SUCCESS", true],
      [1, "observe", "PS-1", "SUCCESS", false],
      [2, "act", "PS-1", "SUCCESS", true],
    ]);
  });

  it("search: our code fills the query (literal inputRef), then the submit control is clicked", async () => {
    const { ctx } = fakeCtx();
    const session = new FakeSession();
    const { recorder, fills } = fakeRecorder({ describe: searchRoles });
    const plan = planOf(step("navigate", "Open"), step("search", "Search for the product", { inputRef: { source: "literal", key: "iPhone 17 Pro" } }));
    const outcome = await runExploration(ctx, { plan, requirement: requirementWith([]), session, budget: ctx.budgetSignal(1) }, { store: memoryStore().store, recorder });
    expect(summary(outcome.steps)).toEqual([
      [0, "navigate", "PS-1", "SUCCESS", true],
      [1, "observe", "PS-2", "SUCCESS", false],
      [2, "fill", "PS-2", "SUCCESS", true],
      [3, "observe", "PS-2", "SUCCESS", false],
      [4, "act", "PS-2", "SUCCESS", true],
    ]);
    expect(fills).toEqual([{ selector: expect.any(String), value: "iPhone 17 Pro" }]);
    expect(outcome.steps[2]!.inputRef).toEqual({ source: "literal", key: "iPhone 17 Pro" });
  });

  it("search whose submit control resolves to the filled field: never clicked, the attempt fails (a model-found observe)", async () => {
    const { ctx } = fakeCtx();
    const field = { selector: "xpath=/html[1]/body[1]/main[1]/form[1]/input[1]", description: "search box", method: "click", arguments: [] };
    const session = new FakeSession({ observe: () => [field] });
    const mem = memoryStore();
    const plan = planOf(step("navigate", "Open"), step("search", "Search for the product using the site search box", { inputRef: { source: "literal", key: "iPhone 17 Pro" } }));
    const outcome = await runExploration(ctx, { plan, requirement: requirementWith([]), session, budget: ctx.budgetSignal(1) }, { store: mem.store, recorder: fakeRecorder().recorder });

    const search = outcome.steps.filter((s) => s.plannedStepId === "PS-2");
    expect(search.map((s) => [s.kind, s.outcome, s.onGoldenPath])).toEqual([
      ["observe", "SUCCESS", false],
      ["fill", "SUCCESS", false],
      ["observe", "SUCCESS", false],
      ["act", "FAILED", false],
      ["observe", "SUCCESS", false],
      ["fill", "SUCCESS", false],
      ["observe", "SUCCESS", false],
      ["act", "FAILED", false],
    ]);
    expect(search[3]!.error).toMatch(/search field itself/);
    expect(session.calls.filter((c) => c.op === "actOn")).toEqual([]);
    // The submit observe asks for a control other than the field the query was typed into.
    const submitObserve = session.calls.filter((c) => c.op === "observe")[1]!.arg as string;
    expect(submitObserve).toMatch(/not the (text )?field/i);
  });

  it("search whose submit fails once then succeeds: exactly one golden fill + one golden act, both from the retry", async () => {
    const { ctx, events } = fakeCtx();
    const session = new FakeSession({ actOn: (_el, n) => (n === 0 ? { success: false, message: "submit did nothing" } : {}) });
    const mem = memoryStore();
    const plan = planOf(step("navigate", "Open"), step("search", "Search for the product", { inputRef: { source: "literal", key: "iPhone 17 Pro" } }));
    const outcome = await runExploration(ctx, { plan, requirement: requirementWith([]), session, budget: ctx.budgetSignal(1) }, { store: mem.store, recorder: fakeRecorder({ describe: searchRoles }).recorder });

    expect(outcome.stopReason).toBe("COMPLETED");
    expect(summary(outcome.steps)).toEqual([
      [0, "navigate", "PS-1", "SUCCESS", true],
      [1, "observe", "PS-2", "SUCCESS", false], // attempt 1
      [2, "fill", "PS-2", "SUCCESS", false],
      [3, "observe", "PS-2", "SUCCESS", false],
      [4, "act", "PS-2", "FAILED", false],
      [5, "observe", "PS-2", "SUCCESS", false], // attempt 2
      [6, "fill", "PS-2", "SUCCESS", true],
      [7, "observe", "PS-2", "SUCCESS", false],
      [8, "act", "PS-2", "SUCCESS", true],
    ]);
    // Persisted and published once each, in order, with the final flag.
    expect(mem.steps).toEqual(outcome.steps);
    expect(events.filter((e) => e.type === "step.recorded").map((e) => (e.payload as { index: number }).index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("search failing both attempts: no step of that planned step is on the golden path", async () => {
    const { ctx } = fakeCtx();
    const session = new FakeSession({ actOn: () => ({ success: false, message: "submit did nothing" }) });
    const mem = memoryStore();
    const plan = planOf(step("navigate", "Open"), step("search", "Search for the product", { inputRef: { source: "literal", key: "iPhone 17 Pro" } }), step("click", "Click the first result"));
    const outcome = await runExploration(ctx, { plan, requirement: requirementWith([]), session, budget: ctx.budgetSignal(1) }, { store: mem.store, recorder: fakeRecorder().recorder });

    expect(outcome.stopReason).toBe("COMPLETED");
    const search = outcome.steps.filter((s) => s.plannedStepId === "PS-2");
    expect(search.map((s) => [s.kind, s.outcome])).toEqual([
      ["observe", "SUCCESS"],
      ["fill", "SUCCESS"],
      ["observe", "SUCCESS"],
      ["act", "FAILED"],
      ["observe", "SUCCESS"],
      ["fill", "SUCCESS"],
      ["observe", "SUCCESS"],
      ["act", "FAILED"],
    ]);
    expect(search.some((s) => s.onGoldenPath)).toBe(false);
    expect(mem.steps).toEqual(outcome.steps);
    expect(outcome.steps.some((s) => s.plannedStepId === "PS-3")).toBe(false);
  });

  it("a search stopped by the step limit mid-execution persists its held steps off the golden path", async () => {
    const { ctx } = fakeCtx({ options: { maxExplorationSteps: 4 } });
    const session = new FakeSession();
    const mem = memoryStore();
    const plan = planOf(step("navigate", "Open"), step("search", "Search for the product", { inputRef: { source: "literal", key: "iPhone 17 Pro" } }));
    const outcome = await runExploration(ctx, { plan, requirement: requirementWith([]), session, budget: ctx.budgetSignal(1) }, { store: mem.store, recorder: fakeRecorder().recorder });
    expect(outcome.stopReason).toBe("STEP_LIMIT_REACHED");
    expect(summary(outcome.steps)).toEqual([
      [0, "navigate", "PS-1", "SUCCESS", true],
      [1, "observe", "PS-2", "SUCCESS", false],
      [2, "fill", "PS-2", "SUCCESS", false], // its submit never ran
      [3, "observe", "PS-2", "SUCCESS", false],
    ]);
    expect(mem.steps).toEqual(outcome.steps);
    expect(session.ops()).not.toContain("actOn");
  });

  it("select with an inputRef selects our value deterministically (never actOn)", async () => {
    const { ctx } = fakeCtx({ testData: { size: "M" } });
    const session = new FakeSession({ observe: () => [{ selector: "xpath=/html[1]/body[1]/select[1]", description: "size", method: "selectOptionFromDropdown", arguments: ["XL"] }] });
    const { recorder, selects } = fakeRecorder({ describe: () => ({ role: "combobox", name: "Size", text: null }) });
    const plan = planOf(step("navigate", "Open"), step("select", "Choose the size", { inputRef: { source: "testData", key: "size" } }));
    const outcome = await runExploration(ctx, { plan, requirement: requirementWith([]), session, budget: ctx.budgetSignal(1) }, { store: memoryStore().store, recorder });
    expect(selects).toEqual([{ selector: "xpath=/html[1]/body[1]/select[1]", value: "M" }]);
    expect(session.ops()).not.toContain("actOn");
    expect(outcome.steps.at(-1)).toMatchObject({ kind: "fill", onGoldenPath: true, inputRef: { source: "testData", key: "size" } });
  });

  it("boolean facts (R24): read as `visible` only when a visible outcome references them; otherwise MODEL_EXTRACTED without a DOM read", async () => {
    const { ctx } = fakeCtx();
    const session = new FakeSession({ extract: () => ({ bannerShown: true, inStock: true }) });
    const { recorder, captures } = fakeRecorder();
    const facts = [
      { key: "bannerShown", checkpoint: "after_add", description: "Added banner is shown", valueType: "boolean" as const },
      { key: "inStock", checkpoint: "after_add", description: "Product is in stock", valueType: "boolean" as const },
    ];
    const requirement = requirementWith(facts, { kind: "visible", fact: { key: "bannerShown", checkpoint: "after_add" }, expected: true });
    const plan = planOf(step("navigate", "Open"), step("capture_checkpoint", "Capture", { checkpoint: "after_add" }));
    const outcome = await runExploration(ctx, { plan, requirement, session, budget: ctx.budgetSignal(1) }, { store: memoryStore().store, recorder });

    expect(captures.map((c) => [c.key, c.mode, c.element !== null])).toEqual([
      ["bannerShown", "visible", true],
      ["inStock", null, false],
    ]);
    expect(outcome.facts.map((f) => [f.key, f.provenance])).toEqual([
      ["url", "DOM_VERIFIED"],
      ["bannerShown", "DOM_VERIFIED"],
      ["inStock", "MODEL_EXTRACTED"],
    ]);
    // Only the fact that gets a DOM read is located.
    expect(session.calls.filter((c) => c.op === "observe")).toHaveLength(1);
  });

  it("wait_for polls observe (bounded) until the element appears", async () => {
    const { ctx } = fakeCtx();
    const session = new FakeSession({ observe: (_i, n) => (n < 1 ? [] : [{ selector: "xpath=/html[1]/body[1]/p[1]", description: "banner", method: null, arguments: [] }]) });
    const plan = planOf(step("navigate", "Open"), step("wait_for", "Wait for the Added to cart message"));
    const outcome = await runExploration(ctx, { plan, requirement: requirementWith([]), session, budget: ctx.budgetSignal(1) }, { store: memoryStore().store, recorder: fakeRecorder().recorder, pollIntervalMs: 1 });
    expect(outcome.stopReason).toBe("COMPLETED");
    expect(summary(outcome.steps)).toEqual([
      [0, "navigate", "PS-1", "SUCCESS", true],
      [1, "observe", "PS-2", "FAILED", false],
      [2, "observe", "PS-2", "SUCCESS", false],
    ]);
  });

  it("a list fact's reads say that a message shown in place of the list (e.g. an empty cart) is what it lists (KI-001)", async () => {
    // In CI mode an empty cart reads as ["Your cart is empty"], the message in the list's place, so a check that the
    // cart contains an item FAILs; a model that answers null instead leaves it FACT_NOT_OBSERVED.
    const { ctx } = fakeCtx();
    const session = new FakeSession({ extract: () => ({ cartItems: ["Your cart is empty"], cartCount: 1 }) });
    const cartItems = { key: "cartItems", checkpoint: "cart_page", description: "The products listed in the cart", valueType: "string_list" as const };
    const cartCount = { key: "cartCount", checkpoint: "cart_page", description: "The cart badge count", valueType: "number" as const };
    const plan = planOf(step("navigate", "Open"), step("capture_checkpoint", "Read the cart", { checkpoint: "cart_page" }));
    await runExploration(ctx, { plan, requirement: requirementWith([cartItems, cartCount]), session, budget: ctx.budgetSignal(1) }, { store: memoryStore().store, recorder: fakeRecorder().recorder });
    const extract = session.calls.find((c) => c.op === "extract")!.arg as string;
    expect(extract).toMatch(/message in place of the list .* its only item/i);
    // Stagehand's element ids ("0-128") are not page text (KI-001).
    expect(extract).toMatch(/the text the page shows, never element ids/i);
    const observes = session.calls.filter((c) => c.op === "observe").map((c) => c.arg as string);
    expect(observes.find((o) => o.includes("The products listed in the cart"))).toMatch(/or the message shown in its place/i);
    expect(observes.find((o) => o.includes("The cart badge count"))).not.toMatch(/in its place/);

    // Without a list fact, the extract keeps its one rule.
    const plain = new FakeSession({ extract: () => ({ cartCount: 1 }) });
    await runExploration(ctx, { plan, requirement: requirementWith([{ ...cartCount, checkpoint: "cart_page" }]), session: plain, budget: ctx.budgetSignal(1) }, { store: memoryStore().store, recorder: fakeRecorder().recorder });
    expect(plain.calls.find((c) => c.op === "extract")!.arg as string).not.toMatch(/in place of the list/);
  });

  it("a fill that finds a link (the way to the field) follows it once and fills the field there (KI-001)", async () => {
    // e.g. "Search the catalog" on a page without a search box: the explorer points at the "Products" link.
    const { ctx } = fakeCtx();
    const link = { selector: "xpath=/html[1]/body[1]/header[1]/a[1]", description: "Products link", method: "click", arguments: [] };
    const field = { selector: "xpath=/html[1]/body[1]/form[1]/input[1]", description: "Search products", method: "fill", arguments: [] };
    const submit = { selector: "xpath=/html[1]/body[1]/form[1]/button[1]", description: "Search", method: "click", arguments: [] };
    const session = new FakeSession({ observe: (instruction, n) => (instruction.startsWith("Find the button") ? [submit] : n === 0 ? [link] : [field]) });
    const roles: Record<string, string> = { [link.selector]: "link", [field.selector]: "searchbox", [submit.selector]: "button" };
    const { recorder, fills } = fakeRecorder({ describe: (selector) => ({ role: roles[selector] ?? "button", name: null, text: null }) });
    const plan = planOf(step("navigate", "Open"), step("search", "Search the catalog for the Galaxy S27", { inputRef: { source: "literal", key: "Galaxy S27" } }));
    const outcome = await runExploration(ctx, { plan, requirement: requirementWith([]), session, budget: ctx.budgetSignal(1) }, { store: memoryStore().store, recorder });
    expect(outcome.stopReason).toBe("COMPLETED");
    expect(summary(outcome.steps)).toEqual([
      [0, "navigate", "PS-1", "SUCCESS", true],
      [1, "observe", "PS-2", "SUCCESS", false],
      [2, "act", "PS-2", "SUCCESS", true],
      [3, "observe", "PS-2", "SUCCESS", false],
      [4, "fill", "PS-2", "SUCCESS", true],
      [5, "observe", "PS-2", "SUCCESS", false],
      [6, "act", "PS-2", "SUCCESS", true],
    ]);
    expect(fills).toEqual([{ selector: field.selector, value: "Galaxy S27" }]);
    expect((session.calls.filter((c) => c.op === "actOn")[0]!.arg as { selector: string }).selector).toBe(link.selector);

    // A link again on the next page: the fill fails as before (no second hop).
    const { ctx: ctx2 } = fakeCtx();
    const loop = new FakeSession({ observe: () => [link] });
    const failed = await runExploration(ctx2, { plan, requirement: requirementWith([]), session: loop, budget: ctx2.budgetSignal(1) }, { store: memoryStore().store, recorder });
    expect(failed.steps.filter((s) => s.kind === "fill").map((s) => [s.outcome, s.error])).toEqual([
      ["FAILED", "The field resolved to a link again after following one"],
      ["FAILED", "The field resolved to a link again after following one"],
    ]);
    // One hop per attempt (a step gets one retry); a failed search attempt's steps are not on the golden path.
    expect(failed.steps.filter((s) => s.kind === "act").map((s) => [s.outcome, s.onGoldenPath])).toEqual([
      ["SUCCESS", false],
      ["SUCCESS", false],
    ]);
  });

  it("a fill that finds a button asks once more for the text field itself (KI-001)", async () => {
    // "Search the shop for the term entered in the search field": the explorer returned the Search button twice.
    const { ctx } = fakeCtx();
    const button = { selector: "xpath=/html[1]/body[1]/form[1]/button[1]", description: "Search", method: "click", arguments: [] };
    const field = { selector: "xpath=/html[1]/body[1]/form[1]/input[1]", description: "Search products", method: "fill", arguments: [] };
    const session = new FakeSession({
      observe: (instruction) => (instruction.startsWith("Find the text field to type into") ? [field] : instruction.startsWith("Find the button that submits") ? [button] : [button]),
    });
    const roles: Record<string, string> = { [button.selector]: "button", [field.selector]: "searchbox" };
    const { recorder, fills } = fakeRecorder({ describe: (selector) => ({ role: roles[selector] ?? "button", name: null, text: null }) });
    const plan = planOf(step("navigate", "Open"), step("search", "Search the shop for the term entered in the search field", { inputRef: { source: "literal", key: "iPhone" } }));
    const outcome = await runExploration(ctx, { plan, requirement: requirementWith([]), session, budget: ctx.budgetSignal(1) }, { store: memoryStore().store, recorder });
    expect(outcome.stopReason).toBe("COMPLETED");
    expect(fills).toEqual([{ selector: field.selector, value: "iPhone" }]);
    expect(outcome.steps.filter((s) => s.kind === "observe").map((s) => s.instruction.split(":")[0])).toEqual([
      "Search the shop for the term entered in the search field",
      "Find the text field to type into, not a button or link",
      "Find the button that submits this search, not the text field the query was typed into",
    ]);
  });

  it("a click with nothing to click on the page asks once for the way there, follows it and clicks (KI-001)", async () => {
    // After logging in, the plan clicks a product link the account page does not show; the Products link leads to it.
    const { ctx } = fakeCtx();
    const products = { selector: "xpath=/html[1]/body[1]/header[1]/a[1]", description: "Products link", method: "click", arguments: [] };
    const product = { selector: "xpath=/html[1]/body[1]/main[1]/a[3]", description: "Galaxy S27", method: "click", arguments: [] };
    let onProducts = false;
    const session = new FakeSession({
      observe: (instruction) => (instruction.startsWith("Find the link or button that leads to") ? [products] : onProducts ? [product] : []),
      actOn: (el) => {
        if (el.selector === products.selector) onProducts = true;
        return {};
      },
    });
    const plan = planOf(step("navigate", "Open"), step("click", "Click the Galaxy S27 product link"));
    const outcome = await runExploration(ctx, { plan, requirement: requirementWith([]), session, budget: ctx.budgetSignal(1) }, { store: memoryStore().store, recorder: fakeRecorder().recorder });
    expect(outcome.stopReason).toBe("COMPLETED");
    expect(summary(outcome.steps)).toEqual([
      [0, "navigate", "PS-1", "SUCCESS", true],
      [1, "observe", "PS-2", "FAILED", false],
      [2, "observe", "PS-2", "SUCCESS", false],
      [3, "act", "PS-2", "SUCCESS", true],
      [4, "observe", "PS-2", "SUCCESS", false],
      [5, "act", "PS-2", "SUCCESS", true],
    ]);
    expect(outcome.steps[2]!.instruction).toBe("Find the link or button that leads to where you can: Click the Galaxy S27 product link");
    expect(session.calls.filter((c) => c.op === "actOn").map((c) => (c.arg as { selector: string }).selector)).toEqual([products.selector, product.selector]);
  });

  it("a fill with no field on the page asks once for the way to its form, opens it and fills there (KI-001)", async () => {
    // The plan types the email on the start page; the login form is behind the "Log in" link.
    const { ctx } = fakeCtx({ testData: { email: "qa@demo.test" } });
    const login = { selector: "xpath=/html[1]/body[1]/header[1]/a[2]", description: "Log in link", method: "click", arguments: [] };
    const email = { selector: "xpath=/html[1]/body[1]/form[1]/input[1]", description: "Email", method: "fill", arguments: [] };
    let opened = false;
    const session = new FakeSession({
      observe: (instruction) => (instruction.startsWith("Find the link or button that opens") ? [login] : opened ? [email] : []),
      actOn: () => {
        opened = true;
        return {};
      },
    });
    const roles: Record<string, string> = { [login.selector]: "link", [email.selector]: "textbox" };
    const { recorder, fills } = fakeRecorder({ describe: (selector) => ({ role: roles[selector] ?? "button", name: null, text: null }) });
    const plan = planOf(step("navigate", "Open"), step("fill", "Type the email into the login email field", { inputRef: { source: "testData", key: "email" } }));
    const outcome = await runExploration(ctx, { plan, requirement: requirementWith([]), session, budget: ctx.budgetSignal(1) }, { store: memoryStore().store, recorder });
    expect(outcome.stopReason).toBe("COMPLETED");
    expect(summary(outcome.steps)).toEqual([
      [0, "navigate", "PS-1", "SUCCESS", true],
      [1, "observe", "PS-2", "FAILED", false],
      [2, "observe", "PS-2", "SUCCESS", false],
      [3, "act", "PS-2", "SUCCESS", true],
      [4, "observe", "PS-2", "SUCCESS", false],
      [5, "fill", "PS-2", "SUCCESS", true],
    ]);
    expect(outcome.steps[2]!.instruction).toBe("Find the link or button that opens the page or form with the field for: Type the email into the login email field");
    expect(fills).toEqual([{ selector: email.selector, value: "qa@demo.test" }]);

    // Nothing that opens it either: the attempt fails with one extra lookup, no click.
    const { ctx: ctx2 } = fakeCtx({ testData: { email: "qa@demo.test" } });
    const nothing = new FakeSession({ observe: () => [] });
    const failed = await runExploration(ctx2, { plan, requirement: requirementWith([]), session: nothing, budget: ctx2.budgetSignal(1) }, { store: memoryStore().store, recorder });
    expect(nothing.ops().filter((o) => o === "actOn")).toEqual([]);
    expect(failed.steps.filter((s) => s.kind === "observe").map((s) => s.outcome)).toEqual(["FAILED", "FAILED", "FAILED", "FAILED"]);
  });

  it("a secret fill the model finds no field for uses the page's only visible password field (KI-001)", async () => {
    // Flash answered "no element" for "Type the user's password into the password field" on a login page.
    const plan = planOf(step("navigate", "Open"), step("fill", "Type the password into the password field", { inputRef: { source: "secret", key: "password" } }));
    const noModelAnswer = () => new FakeSession({ observe: () => [] });

    const { ctx } = fakeCtx({ secrets: { password: SECRET } });
    const { recorder, fills } = fakeRecorder({ describe: () => ({ role: "textbox", name: "Password", text: null }) });
    const outcome = await runExploration(ctx, { plan, requirement: requirementWith([]), session: noModelAnswer(), budget: ctx.budgetSignal(1) }, { store: memoryStore().store, recorder });
    expect(outcome.stopReason).toBe("COMPLETED");
    expect(summary(outcome.steps)).toEqual([
      [0, "navigate", "PS-1", "SUCCESS", true],
      [1, "observe", "PS-2", "FAILED", false],
      [2, "observe", "PS-2", "SUCCESS", false],
      [3, "fill", "PS-2", "SUCCESS", true],
    ]);
    expect(outcome.steps[2]).toMatchObject({ instruction: expect.stringContaining("the page's only password field"), llm: null });
    expect(fills).toEqual([{ selector: 'input[type="password"] >> visible=true', value: SECRET }]);

    // Not exactly one password field, or a value that is not a secret: no fallback, the fill fails as before.
    const { ctx: two } = fakeCtx({ secrets: { password: SECRET } });
    const several = fakeRecorder({ unique: (selector) => !selector.includes("password") });
    const none = await runExploration(two, { plan, requirement: requirementWith([]), session: noModelAnswer(), budget: two.budgetSignal(1) }, { store: memoryStore().store, recorder: several.recorder });
    expect(several.fills).toEqual([]);
    expect(none.steps.filter((s) => s.kind === "fill")).toEqual([]);

    const { ctx: data } = fakeCtx({ testData: { email: "qa@demo.test" } });
    const typed = fakeRecorder();
    const emailPlan = planOf(step("navigate", "Open"), step("fill", "Type the email", { inputRef: { source: "testData", key: "email" } }));
    await runExploration(data, { plan: emailPlan, requirement: requirementWith([]), session: noModelAnswer(), budget: data.budgetSignal(1) }, { store: memoryStore().store, recorder: typed.recorder });
    expect(typed.fills).toEqual([]);
  });

  it("a click located on an element that cannot be clicked (a status badge) asks once more for the link or button (KI-001)", async () => {
    // "Open the cart page from the cart indicator link": the explorer returned the "Cart (1)" badge, a status element.
    const { ctx } = fakeCtx();
    const badge = { selector: "xpath=/html[1]/body[1]/header[1]/span[2]", description: "Cart (1)", method: "click", arguments: [] };
    const link = { selector: "xpath=/html[1]/body[1]/header[1]/nav[1]/a[2]", description: "Cart", method: "click", arguments: [] };
    const session = new FakeSession({ observe: (instruction) => (instruction.startsWith("Find the link or button to click") ? [link] : [badge]) });
    const roles: Record<string, string> = { [badge.selector]: "status", [link.selector]: "link" };
    const { recorder } = fakeRecorder({ describe: (selector) => ({ role: roles[selector] ?? null, name: null, text: null }) });
    const plan = planOf(step("navigate", "Open"), step("click", "Open the cart page from the cart indicator link"));
    await runExploration(ctx, { plan, requirement: requirementWith([]), session, budget: ctx.budgetSignal(1) }, { store: memoryStore().store, recorder });
    expect(session.calls.filter((c) => c.op === "actOn").map((c) => (c.arg as { selector: string }).selector)).toEqual([link.selector]);
    expect(session.calls.filter((c) => c.op === "observe").map((c) => (c.arg as string).split(":")[0])).toEqual([
      "Open the cart page from the cart indicator link",
      "Find the link or button to click, not text, a heading or a status",
    ]);
  });

  it("a fact whose located element has nothing to read is looked for once more as the element that shows it itself (KI-001)", async () => {
    // "Number shown in the cart badge/link": the explorer returned the Cart link, whose text has no number.
    const { ctx } = fakeCtx();
    const link = { selector: "xpath=/html[1]/body[1]/header[1]/nav[1]/a[2]", description: "Cart", method: null, arguments: [] };
    const badge = { selector: "xpath=/html[1]/body[1]/header[1]/span[2]", description: "Cart (0)", method: null, arguments: [] };
    const session = new FakeSession({
      extract: () => ({ cartCount: 0 }),
      observe: (instruction) => (instruction.startsWith("Find the element whose own text shows") ? [badge] : [link]),
    });
    const { recorder } = fakeRecorder({ readings: { [link.selector]: null, [badge.selector]: 0 } });
    const plan = planOf(step("navigate", "Open"), step("capture_checkpoint", "Read the badge", { checkpoint: "after_add" }));
    const outcome = await runExploration(ctx, { plan, requirement: requirementWith([cartFact]), session, budget: ctx.budgetSignal(1) }, { store: memoryStore().store, recorder });
    expect(outcome.facts.find((f) => f.key === "cartCount")).toMatchObject({ value: 0, provenance: "DOM_VERIFIED", read: { element: { candidates: [{ selector: badge.selector }] } } });
  });

  it("a value the model read as null where the located element shows one is read once more, alone (KI-001)", async () => {
    // Extract said "not shown" while the explorer located the product link; the page reads "iPhone 17 Pro" there.
    const { ctx } = fakeCtx();
    let extracts = 0;
    const session = new FakeSession({ extract: () => (++extracts === 1 ? { productName: null, cartCount: 1 } : { productName: "iPhone 17 Pro" }) });
    const { recorder } = fakeRecorder({ dom: { productName: "iPhone 17 Pro" } });
    const facts = [
      { key: "productName", checkpoint: "results", description: "Name of the selected product", valueType: "string" as const },
      { key: "cartCount", checkpoint: "results", description: "Cart badge count", valueType: "number" as const },
    ];
    const plan = planOf(step("navigate", "Open"), step("capture_checkpoint", "Read the results", { checkpoint: "results" }));
    const outcome = await runExploration(ctx, { plan, requirement: requirementWith(facts), session, budget: ctx.budgetSignal(1) }, { store: memoryStore().store, recorder });
    expect(outcome.facts.filter((f) => f.key !== "url").map((f) => [f.key, f.value, f.provenance])).toEqual([
      ["productName", "iPhone 17 Pro", "DOM_VERIFIED"],
      ["cartCount", 1, "DOM_VERIFIED"],
    ]);
    const asked = session.calls.filter((c) => c.op === "extract").map((c) => c.arg as string);
    expect(asked).toHaveLength(2);
    expect(asked[1]).toContain("- productName: Name of the selected product (string)");
    expect(asked[1]).not.toContain("cartCount");
  });

  it("a list fact whose container is not found is looked for once more as the element that shows it (KI-001)", async () => {
    const { ctx } = fakeCtx();
    const list = { selector: "xpath=/html[1]/body[1]/main[1]/ul[1]", description: "Cart items list", method: null, arguments: [] };
    const session = new FakeSession({
      extract: () => ({ cartItems: ["iPhone 17 Pro"] }),
      observe: (instruction) => (instruction.startsWith("Find the element that shows: The products listed in the cart") ? [list] : []),
    });
    const { recorder, captures } = fakeRecorder();
    const cartItems = { key: "cartItems", checkpoint: "cart_page", description: "The products listed in the cart", valueType: "string_list" as const };
    const plan = planOf(step("navigate", "Open"), step("capture_checkpoint", "Read the cart", { checkpoint: "cart_page" }));
    const outcome = await runExploration(ctx, { plan, requirement: requirementWith([cartItems]), session, budget: ctx.budgetSignal(1) }, { store: memoryStore().store, recorder });
    const observes = outcome.steps.filter((s) => s.kind === "observe").map((s) => [s.instruction.split(":")[0], s.outcome]);
    expect(observes).toEqual([
      ["Find the list or container whose items are", "FAILED"],
      ["Find the element that shows", "SUCCESS"],
    ]);
    expect(captures[0]).toMatchObject({ key: "cartItems", element: { candidates: [{ selector: list.selector }] }, mode: "text_list" });
  });

  it("a wait_for whose element never appears is recorded as failed and exploration goes on (KI-001)", async () => {
    // e.g. "Wait for the cart page to load": no element to find, but the page is there. The checkpoint's facts
    // decide the criteria; a step that needed the missing element fails on its own.
    const { ctx } = fakeCtx();
    const button = [{ selector: "xpath=/html[1]/body[1]/button[1]", description: "Add to cart", method: "click", arguments: [] }];
    const session = new FakeSession({ observe: (instruction) => (instruction.startsWith("Wait") ? [] : button) });
    const plan = planOf(step("navigate", "Open"), step("wait_for", "Wait for the product page to load"), step("click", "Click Add to cart"));
    const outcome = await runExploration(ctx, { plan, requirement: requirementWith([]), session, budget: ctx.budgetSignal(1) }, { store: memoryStore().store, recorder: fakeRecorder().recorder, pollIntervalMs: 1 });
    expect(outcome.stopReason).toBe("COMPLETED");
    expect(summary(outcome.steps)).toEqual([
      [0, "navigate", "PS-1", "SUCCESS", true],
      [1, "observe", "PS-2", "FAILED", false],
      [2, "observe", "PS-2", "FAILED", false],
      [3, "observe", "PS-2", "FAILED", false],
      [4, "observe", "PS-3", "SUCCESS", false],
      [5, "act", "PS-3", "SUCCESS", true],
    ]);
  });
});

describe("exploration cache (V1.1 F8)", () => {
  function memoryCache(seed: Record<string, CachedElement> = {}, opts: { fail?: boolean } = {}) {
    const entries = new Map(Object.entries(seed));
    const touched: string[] = [];
    const puts: { key: string; where: CacheWhere; entry: CachedElement }[] = [];
    const cache: ObserveCache = {
      async get(key) {
        if (opts.fail) throw new Error("db down");
        return entries.get(key) ?? null;
      },
      async put(key, where, entry) {
        if (opts.fail) throw new Error("db down");
        puts.push({ key, where, entry });
        entries.set(key, entry);
      },
      async touch(key) {
        touched.push(key);
      },
    };
    return { cache, entries, touched, puts };
  }
  /** Never picks a hit for a recheck (the default rate is 10 %). */
  const NO_RECHECK = () => 1;
  const clickPlan = () => planOf(step("navigate", "Open the product page"), step("click", "Click Add to cart"));
  const keyFor = (instruction: string) => observeCacheKey(TARGET, instruction)!.key;
  const cached = (selector: string): CachedElement => ({
    selector,
    description: "Add to cart button",
    method: "click",
    element: { candidates: [{ strategy: "xpath", selector }], chosenIndex: 0, framePath: [] },
  });

  it("keys on origin + path + the redacted instruction, never the query or fragment", () => {
    const a = observeCacheKey("https://shop.test/products/1?session=abc#x", "Click Add to cart")!;
    const b = observeCacheKey("https://shop.test/products/1", "Click Add to cart")!;
    expect(a.key).toBe(b.key);
    expect(a.where).toEqual({ origin: "https://shop.test", path: "/products/1" });
    expect(observeCacheKey("https://shop.test/products/2", "Click Add to cart")!.key).not.toBe(b.key);
    expect(observeCacheKey("about:blank", "x")).toBeNull();
  });

  it("a miss observes, and the lookup is written only after the planned step succeeded", async () => {
    const { ctx } = fakeCtx();
    const session = new FakeSession();
    const mem = memoryCache();
    await runExploration(ctx, { plan: clickPlan(), requirement: requirementWith([]), session, budget: ctx.budgetSignal(1) }, { store: memoryStore().store, recorder: fakeRecorder().recorder, cache: mem.cache, random: NO_RECHECK });
    expect(session.ops().filter((o) => o === "observe")).toHaveLength(1);
    expect(mem.puts).toEqual([{ key: keyFor("Click Add to cart"), where: { origin: "https://shop.test", path: "/products/1" }, entry: { ...cached("xpath=/html[1]/body[1]/el[1]"), description: "an element" } }]);
  });

  it("a wait_for caches the element it found, and nothing when none appeared", async () => {
    const waitPlan = planOf(step("navigate", "Open the product page"), step("wait_for", "Wait for the Added to cart message"));
    const { ctx } = fakeCtx();
    const mem = memoryCache();
    await runExploration(ctx, { plan: waitPlan, requirement: requirementWith([]), session: new FakeSession(), budget: ctx.budgetSignal(1) }, { store: memoryStore().store, recorder: fakeRecorder().recorder, cache: mem.cache, random: NO_RECHECK, pollIntervalMs: 1 });
    expect(mem.puts.map((p) => p.key)).toEqual([keyFor("Wait for the Added to cart message")]);

    const none = memoryCache();
    await runExploration(ctx, { plan: waitPlan, requirement: requirementWith([]), session: new FakeSession({ observe: () => [] }), budget: ctx.budgetSignal(1) }, { store: memoryStore().store, recorder: fakeRecorder().recorder, cache: none.cache, random: NO_RECHECK, pollIntervalMs: 1 });
    expect(none.puts).toEqual([]);
  });

  it("a hit replaces the observe: no model call, recorded with cacheHit, and counted", async () => {
    const { ctx } = fakeCtx();
    const session = new FakeSession();
    const mem = memoryCache({ [keyFor("Click Add to cart")]: cached("xpath=/html[1]/body[1]/button[3]") });
    const outcome = await runExploration(ctx, { plan: clickPlan(), requirement: requirementWith([]), session, budget: ctx.budgetSignal(1) }, { store: memoryStore().store, recorder: fakeRecorder().recorder, cache: mem.cache, random: NO_RECHECK });
    expect(session.ops()).not.toContain("observe");
    expect(session.calls.find((c) => c.op === "actOn")!.arg).toMatchObject({ selector: "xpath=/html[1]/body[1]/button[3]", method: "click", arguments: [] });
    expect(outcome.steps.find((s) => s.kind === "observe")).toMatchObject({ outcome: "SUCCESS", llm: { inputTokens: 0, outputTokens: 0, cacheHit: true } });
    expect(mem.touched).toEqual([keyFor("Click Add to cart")]);
    expect(mem.puts).toEqual([]);
  });

  it("a stale entry (another element's locator now) is a miss", async () => {
    const { ctx } = fakeCtx();
    const session = new FakeSession();
    const stale = { ...cached("xpath=/html[1]/body[1]/button[3]"), element: { candidates: [{ strategy: "testId" as const, value: "old-button" }], chosenIndex: 0, framePath: [] } };
    const mem = memoryCache({ [keyFor("Click Add to cart")]: stale });
    await runExploration(ctx, { plan: clickPlan(), requirement: requirementWith([]), session, budget: ctx.budgetSignal(1) }, { store: memoryStore().store, recorder: fakeRecorder().recorder, cache: mem.cache, random: NO_RECHECK });
    expect(session.ops().filter((o) => o === "observe")).toHaveLength(1);
    expect(mem.puts.map((p) => p.entry.selector)).toEqual(["xpath=/html[1]/body[1]/el[1]"]);
  });

  it("never caches a failed or blocked step, and the policy still checks a cached element", async () => {
    const { ctx } = fakeCtx();
    const failing = new FakeSession({ actOn: () => ({ success: false, message: "detached" }) });
    const mem = memoryCache();
    await runExploration(ctx, { plan: clickPlan(), requirement: requirementWith([]), session: failing, budget: ctx.budgetSignal(1) }, { store: memoryStore().store, recorder: fakeRecorder().recorder, cache: mem.cache, random: NO_RECHECK });
    expect(mem.puts).toEqual([]);

    const { ctx: ctx2 } = fakeCtx();
    const destructive = memoryCache({ [keyFor("Click Add to cart")]: cached("xpath=/html[1]/body[1]/button[9]") });
    const session = new FakeSession();
    const outcome = await runExploration(
      ctx2,
      { plan: clickPlan(), requirement: requirementWith([]), session, budget: ctx2.budgetSignal(1) },
      { store: memoryStore().store, recorder: fakeRecorder({ describe: () => ({ role: "button", name: "Delete account", text: "Delete account" }) }).recorder, cache: destructive.cache, random: NO_RECHECK },
    );
    expect(outcome.stopReason).toBe("BLOCKED_BY_POLICY");
    expect(session.ops()).not.toContain("actOn");
  });

  it("a failing cache is only a miss", async () => {
    const { ctx } = fakeCtx();
    const session = new FakeSession();
    const outcome = await runExploration(ctx, { plan: clickPlan(), requirement: requirementWith([]), session, budget: ctx.budgetSignal(1) }, { store: memoryStore().store, recorder: fakeRecorder().recorder, cache: memoryCache({}, { fail: true }).cache, random: NO_RECHECK });
    expect(outcome.stopReason).toBe("COMPLETED");
    expect(session.ops()).toContain("actOn");
  });

  it("a hit whose element now does something else is a miss (KI-032)", async () => {
    const actions: Record<string, string> = { "xpath=/html[1]/body[1]/button[3]": "a||https://shop.test/account/delete||" };
    const recorder = { ...fakeRecorder().recorder, action: async (_page: unknown, selector: string) => actions[selector] ?? "button|submit|||" };
    const { ctx } = fakeCtx();
    const session = new FakeSession();
    const moved = { ...cached("xpath=/html[1]/body[1]/button[3]"), action: "a||https://shop.test/cart/add||" };
    const mem = memoryCache({ [keyFor("Click Add to cart")]: moved });
    await runExploration(ctx, { plan: clickPlan(), requirement: requirementWith([]), session, budget: ctx.budgetSignal(1) }, { store: memoryStore().store, recorder, cache: mem.cache, random: NO_RECHECK });
    expect(session.ops().filter((o) => o === "observe")).toHaveLength(1);
    // The fresh lookup replaces the entry, with its own action.
    expect(mem.puts.map((p) => [p.entry.selector, p.entry.action])).toEqual([["xpath=/html[1]/body[1]/el[1]", "button|submit|||"]]);

    // Unchanged, the same entry is a hit; an entry written before KI-032 (no action) is a miss.
    const { ctx: ctx2 } = fakeCtx();
    const same = new FakeSession();
    const hit = memoryCache({ [keyFor("Click Add to cart")]: { ...moved, action: "a||https://shop.test/account/delete||" } });
    await runExploration(ctx2, { plan: clickPlan(), requirement: requirementWith([]), session: same, budget: ctx2.budgetSignal(1) }, { store: memoryStore().store, recorder, cache: hit.cache, random: NO_RECHECK });
    expect(same.ops()).not.toContain("observe");
    const { ctx: ctx3 } = fakeCtx();
    const legacy = new FakeSession();
    const old = memoryCache({ [keyFor("Click Add to cart")]: cached("xpath=/html[1]/body[1]/button[3]") });
    await runExploration(ctx3, { plan: clickPlan(), requirement: requirementWith([]), session: legacy, budget: ctx3.budgetSignal(1) }, { store: memoryStore().store, recorder, cache: old.cache, random: NO_RECHECK });
    expect(legacy.ops().filter((o) => o === "observe")).toHaveLength(1);
  });

  it("a sampled hit is looked up again and the fresh lookup replaces it (KI-032)", async () => {
    const { ctx } = fakeCtx();
    const session = new FakeSession();
    const mem = memoryCache({ [keyFor("Click Add to cart")]: cached("xpath=/html[1]/body[1]/button[3]") });
    const outcome = await runExploration(
      ctx,
      { plan: clickPlan(), requirement: requirementWith([]), session, budget: ctx.budgetSignal(1) },
      { store: memoryStore().store, recorder: fakeRecorder().recorder, cache: mem.cache, cacheRecheckRate: 0.1, random: () => 0.05 },
    );
    expect(session.ops().filter((o) => o === "observe")).toHaveLength(1);
    expect(outcome.steps.find((s) => s.kind === "observe")!.llm).toEqual(USAGE);
    expect(mem.touched).toEqual([]);
    expect(mem.puts.map((p) => p.entry.selector)).toEqual(["xpath=/html[1]/body[1]/el[1]"]);
  });
});

describe("several scenarios (V1.1 F9)", () => {
  function twoScenarioPlan(first: PlannedStep[], second: PlannedStep[]): TestPlan {
    let n = 0;
    const ids = (steps: PlannedStep[]) => steps.map((s) => ({ ...s, id: `PS-${++n}` }));
    return {
      runId: "run_exec",
      requirementRevision: 1,
      scenarios: [
        { id: "SC-1", title: "signed out", criterionIds: ["AC-1"], steps: ids(first) },
        { id: "SC-2", title: "signed in", criterionIds: ["AC-2"], steps: ids(second) },
      ],
      blockedCriteria: [],
      stopConditions: [],
    };
  }
  const run = (plan: TestPlan, session: FakeSession, extra: { resetSession?: (page: unknown, url: string) => Promise<void>; max?: number } = {}) => {
    const { ctx } = fakeCtx(extra.max ? { options: { maxExplorationSteps: extra.max } } : {});
    const resets: string[] = [];
    const resetSession = extra.resetSession ?? (async (_page: unknown, url: string) => void resets.push(url));
    const outcome = runExploration(ctx, { plan, requirement: requirementWith([]), session, budget: ctx.budgetSignal(1) }, { store: memoryStore().store, recorder: fakeRecorder().recorder, resetSession });
    return { outcome, resets };
  };

  it("runs the scenarios in order, each from a cleared session at the target, and tags each step with its scenario", async () => {
    const session = new FakeSession();
    const { outcome, resets } = run(twoScenarioPlan([step("navigate", "Open the home page"), step("click", "Open the banner")], [step("navigate", "Open the home page"), step("click", "Open My orders")]), session);
    const result = await outcome;
    expect(resets).toEqual([TARGET]);
    expect(session.calls.filter((c) => c.op === "navigate").map((c) => c.arg)).toEqual([TARGET, TARGET]);
    expect(result.steps.map((s) => [s.scenarioId, s.kind, s.plannedStepId])).toEqual([
      ["SC-1", "navigate", "PS-1"],
      ["SC-1", "observe", "PS-2"],
      ["SC-1", "act", "PS-2"],
      ["SC-2", "navigate", "PS-3"],
      ["SC-2", "observe", "PS-4"],
      ["SC-2", "act", "PS-4"],
    ]);
    expect(result).toMatchObject({ stopReason: "COMPLETED", scenarioStops: { "SC-1": "COMPLETED", "SC-2": "COMPLETED" } });
  });

  it("a step that fails or is blocked ends only its own scenario", async () => {
    const session = new FakeSession();
    const blocked = step("click", "Click Delete account", { destructive: true });
    const { outcome } = run(twoScenarioPlan([step("navigate", "Open the home page"), blocked], [step("navigate", "Open the home page"), step("click", "Open My orders")]), session);
    const result = await outcome;
    expect(result).toMatchObject({ stopReason: "BLOCKED_BY_POLICY", scenarioStops: { "SC-1": "BLOCKED_BY_POLICY", "SC-2": "COMPLETED" } });
    expect(result.steps.filter((s) => s.scenarioId === "SC-2").map((s) => s.outcome)).toEqual(["SUCCESS", "SUCCESS", "SUCCESS"]);
  });

  it("the step limit ends exploration: later scenarios are not explored", async () => {
    const session = new FakeSession();
    const { outcome, resets } = run(twoScenarioPlan([step("navigate", "Open the home page"), step("click", "A"), step("click", "B")], [step("navigate", "Open the home page")]), session, { max: 3 });
    const result = await outcome;
    expect(result).toMatchObject({ stopReason: "STEP_LIMIT_REACHED", scenarioStops: { "SC-1": "STEP_LIMIT_REACHED", "SC-2": "STEP_LIMIT_REACHED" } });
    expect(resets).toEqual([]);
    expect(result.steps.every((s) => s.scenarioId === "SC-1")).toBe(true);
  });

  it("a session that cannot be cleared is the browser's failure, never a guess", async () => {
    const session = new FakeSession();
    const { outcome } = run(twoScenarioPlan([step("navigate", "Open the home page")], [step("navigate", "Open the home page")]), session, {
      resetSession: async () => {
        throw new Error("CDP gone");
      },
    });
    await expect(outcome).rejects.toBeInstanceOf(BrowserProviderError);
  });

  it("a one-scenario plan records no scenario ids or scenario stops (unchanged)", async () => {
    const { ctx } = fakeCtx();
    const result = await runExploration(ctx, { plan: planOf(step("navigate", "Open")), requirement: requirementWith([]), session: new FakeSession(), budget: ctx.budgetSignal(1) }, { store: memoryStore().store, recorder: fakeRecorder().recorder });
    expect(result.steps[0]).not.toHaveProperty("scenarioId");
    expect(result).not.toHaveProperty("scenarioStops");
  });
});

// ---------------------------------------------------------------------------------------------
// Unclear (semantic) criteria judged from the page (2026-10-07)
// ---------------------------------------------------------------------------------------------

describe("judging unclear criteria from what the page shows", () => {
  const judged = (verdict: "HOLDS" | "DOES_NOT_HOLD" = "HOLDS") => {
    const requests: JudgeRequest[] = [];
    const judge: CriterionJudge = {
      async judge(req) {
        requests.push(req);
        return { judgment: { relevant: true, verdict, observed: "The cart shows 1 item", reasoning: "Read as: the count went up" }, llm: USAGE };
      },
    };
    return { judge, requests };
  };
  /** A page with a body to read: the judge's page scan. */
  const withPage = (session: FakeSession, text = "Cart (1)\nCheckout") => {
    Object.assign(session.page, {
      evaluate: async (script: string) => (script.includes("innerText") && !script.includes("headings") ? text : { title: "Cart", headings: [{ level: 1, text: "Your cart" }] }),
    });
    return session;
  };

  it("after the last step that names it: page scan + viewport screenshot, one judge step with the judgment (off the golden path)", async () => {
    const { ctx } = fakeCtx();
    const session = withPage(new FakeSession());
    const mem = memoryStore();
    const { judge, requests } = judged();
    const plan = planOf(
      step("navigate", "Open the product page"),
      step("click", "Click Add to cart", { criterionIds: ["AC-1"] }),
      step("click", "Open the cart", { criterionIds: ["AC-1"] }),
      step("click", "Go back"),
    );

    const outcome = await runExploration(ctx, { plan, requirement: requirementWith([]), session, budget: ctx.budgetSignal(1) }, { store: mem.store, recorder: fakeRecorder().recorder, judge });

    expect(summary(outcome.steps)).toEqual([
      [0, "navigate", "PS-1", "SUCCESS", true],
      [1, "observe", "PS-2", "SUCCESS", false],
      [2, "act", "PS-2", "SUCCESS", true],
      [3, "observe", "PS-3", "SUCCESS", false],
      [4, "act", "PS-3", "SUCCESS", true],
      [5, "judge", "PS-3", "SUCCESS", false], // after "Open the cart", the last step naming AC-1
      [6, "observe", "PS-4", "SUCCESS", false],
      [7, "act", "PS-4", "SUCCESS", true],
    ]);
    const judgeStep = outcome.steps[5]!;
    expect(judgeStep).toMatchObject({
      judgment: { criterionId: "AC-1", relevant: true, verdict: "HOLDS", observed: "The cart shows 1 item" },
      llm: USAGE,
      artifactIds: ["art_1"],
    });
    expect(mem.screenshots).toMatchObject([{ fileName: "judge-AC-1.png" }]);
    expect(session.calls.filter((c) => c.op === "screenshot").map((c) => c.arg)).toEqual([{ fullPage: false }]); // what is on screen
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      requirement: "Add iPhone 17 Pro to the cart; the cart count increases.",
      criterion: { id: "AC-1" },
      stepDescription: "Open the cart",
      text: "Cart (1)\nCheckout",
      inventory: { title: "Cart", headings: [{ level: 1, text: "Your cart" }] },
    });
    expect(requests[0]!.screenshot).toBeInstanceOf(Buffer);
  });

  it("a criterion no step names is judged once the scenario's last step is done", async () => {
    const { ctx } = fakeCtx();
    const session = withPage(new FakeSession());
    const { judge, requests } = judged("DOES_NOT_HOLD");
    const plan = planOf(step("navigate", "Open the product page"), step("click", "Click Add to cart"));
    const outcome = await runExploration(ctx, { plan, requirement: requirementWith([]), session, budget: ctx.budgetSignal(1) }, { store: memoryStore().store, recorder: fakeRecorder().recorder, judge });
    expect(outcome.steps.at(-1)).toMatchObject({ kind: "judge", plannedStepId: null, judgment: { verdict: "DOES_NOT_HOLD" } });
    expect(requests[0]!.stepDescription).toBeNull();
  });

  it("a model failure records a FAILED judge step and exploration goes on; no judge, no judge step; criteria with rules are never judged", async () => {
    const failing: CriterionJudge = {
      judge: async () => {
        throw new Error("model said nonsense");
      },
    };
    const plan = () => planOf(step("navigate", "Open the product page"), step("click", "Click Add to cart", { criterionIds: ["AC-1"] }));
    const a = fakeCtx();
    const failed = await runExploration(a.ctx, { plan: plan(), requirement: requirementWith([]), session: withPage(new FakeSession()), budget: a.ctx.budgetSignal(1) }, { store: memoryStore().store, recorder: fakeRecorder().recorder, judge: failing });
    expect(failed.stopReason).toBe("COMPLETED");
    expect(failed.steps.at(-1)).toMatchObject({ kind: "judge", outcome: "FAILED", error: "model said nonsense" });
    expect(failed.steps.at(-1)!.judgment).toBeUndefined();

    const b = fakeCtx();
    const none = await runExploration(b.ctx, { plan: plan(), requirement: requirementWith([]), session: withPage(new FakeSession()), budget: b.ctx.budgetSignal(1) }, { store: memoryStore().store, recorder: fakeRecorder().recorder, judge: null });
    expect(none.steps.map((s) => s.kind)).not.toContain("judge");

    const c = fakeCtx();
    const { judge, requests } = judged();
    const visible = { kind: "visible", fact: { key: "cartCount", checkpoint: "after_add" }, expected: true } as const;
    await runExploration(c.ctx, { plan: plan(), requirement: requirementWith([], visible), session: withPage(new FakeSession()), budget: c.ctx.budgetSignal(1) }, { store: memoryStore().store, recorder: fakeRecorder().recorder, judge });
    expect(requests).toEqual([]);
  });

  it("a criterion the plan blocked is not judged", async () => {
    const { ctx } = fakeCtx();
    const { judge, requests } = judged();
    const plan = { ...planOf(step("navigate", "Open the product page")), blockedCriteria: [{ criterionId: "AC-1", reason: "DESTRUCTIVE_ACTION_NOT_AUTHORIZED" as const, detail: "x" }] };
    await runExploration(ctx, { plan, requirement: requirementWith([]), session: withPage(new FakeSession()), budget: ctx.budgetSignal(1) }, { store: memoryStore().store, recorder: fakeRecorder().recorder, judge });
    expect(requests).toEqual([]);
  });
});
