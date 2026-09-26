import {
  ContractError,
  NormalizedRequirementSchema,
  TestPlanSchema,
  type NormalizedRequirement,
  type ProvisionalResult,
  type RunLifecycle,
  type StoredTestRunRequest,
  type TestPlan,
} from "@platform/contracts";
import { FakeTransport, LlmClient, type FakeReply } from "@platform/llm";
import { createRunRedactor, type ActionPolicy } from "@platform/security";
import { describe, expect, it } from "vitest";
import { createFakeStages } from "../orchestrator/fake-stages";
import { runExecution, type RunPorts } from "../orchestrator/orchestrator";
import { createRealStages } from "../orchestrator/real-stages";
import type { EventDraft, StageContext } from "../orchestrator/stages";
import { actionPolicyFor, createPlanStage, planTest, type PlanTestInput } from "./planner";

// ---------------------------------------------------------------------------------------------
// Fixtures

type StepOut = {
  kind: string;
  description: string;
  inputRef: { source: "testData" | "secret" | "literal"; key: string } | null;
  checkpoint: string | null;
  criterionIds: string[];
  destructive: boolean;
};

const step = (kind: string, description: string, extra: Partial<StepOut> = {}): StepOut => ({
  kind,
  description,
  inputRef: null,
  checkpoint: null,
  criterionIds: [],
  destructive: false,
  ...extra,
});
const capture = (checkpoint: string, criterionIds: string[] = []) =>
  step("capture_checkpoint", `Capture the page state (${checkpoint})`, { checkpoint, criterionIds });

const CART_TEXT =
  'Search for "iPhone" and add it to the cart. The cart count increases by 1. The cart lists the product. ' +
  "The cart page shows a checkout button. The cart looks tidy.";

const confirmed = (req: Omit<NormalizedRequirement, "runId" | "revision" | "confirmedAt">): NormalizedRequirement =>
  NormalizedRequirementSchema.parse({ ...req, runId: "run_1", revision: 2, confirmedAt: "2026-09-25T10:00:00.000Z" });

/** 4 criteria: a delta (before/after), a collection (after + cart page), a visible fact, a semantic one. */
const cartRequirement = () =>
  confirmed({
    originalText: CART_TEXT,
    criteria: [
      {
        id: "AC-1",
        sourceText: "The cart count increases by 1.",
        statement: "The cart count increases by 1 after adding the product",
        expectedOutcome: {
          kind: "numeric_delta",
          before: { key: "cartCount", checkpoint: "before_add" },
          after: { key: "cartCount", checkpoint: "after_add" },
          delta: 1,
        },
        preconditions: [],
        ambiguity: null,
      },
      {
        id: "AC-2",
        sourceText: "The cart lists the product.",
        statement: "The cart lists the added product",
        expectedOutcome: {
          kind: "collection_contains",
          collection: { key: "cartItems", checkpoint: "cart_page" },
          item: { key: "productName", checkpoint: "before_add" },
          match: "contains",
        },
        preconditions: [],
        ambiguity: null,
      },
      {
        id: "AC-3",
        sourceText: "The cart page shows a checkout button.",
        statement: "A checkout button is visible on the cart page",
        expectedOutcome: { kind: "visible", fact: { key: "checkoutButton", checkpoint: "cart_page" }, expected: true },
        preconditions: [],
        ambiguity: null,
      },
      {
        id: "AC-4",
        sourceText: "The cart looks tidy.",
        statement: "The cart looks tidy",
        expectedOutcome: { kind: "semantic", description: "The cart looks tidy." },
        preconditions: [],
        ambiguity: null,
      },
    ],
    facts: [
      { key: "cartCount", checkpoint: "before_add", description: "Cart badge count", valueType: "number" },
      { key: "productName", checkpoint: "before_add", description: "Product name", valueType: "string" },
      { key: "cartCount", checkpoint: "after_add", description: "Cart badge count", valueType: "number" },
      { key: "cartItems", checkpoint: "cart_page", description: "Names of the items in the cart", valueType: "string_list" },
      { key: "checkoutButton", checkpoint: "cart_page", description: "Checkout button", valueType: "boolean" },
    ],
  });

/** What a well-behaved model returns for the cart requirement. */
const cartPlan = () => ({
  title: "Add a product to the cart and check the cart",
  steps: [
    step("navigate", "Open the shop home page"),
    step("search", "Search for the product", { inputRef: { source: "literal", key: "iPhone" } }),
    step("click", "Open the first search result"),
    capture("before_add", ["AC-1", "AC-2"]),
    step("click", "Click the Add to cart button", { criterionIds: ["AC-1"] }),
    capture("after_add", ["AC-1"]),
    step("click", "Open the cart"),
    capture("cart_page", ["AC-2", "AC-3", "AC-4"]),
  ],
  stopConditions: ["The product cannot be found"],
});

const LOGIN_TEXT = "A logged-in customer sees their order history. The home page shows a banner.";

/** AC-2 is captured before login; AC-1 needs the login (email from testData, password secret). */
const loginRequirement = (preconditions: NormalizedRequirement["criteria"][number]["preconditions"] = []) =>
  confirmed({
    originalText: LOGIN_TEXT,
    criteria: [
      {
        id: "AC-1",
        sourceText: "A logged-in customer sees their order history.",
        statement: "The order history is visible after login",
        expectedOutcome: { kind: "visible", fact: { key: "orderHistory", checkpoint: "orders_page" }, expected: true },
        preconditions: [{ kind: "authenticated", description: "User is logged in" }, ...preconditions],
        ambiguity: null,
      },
      {
        id: "AC-2",
        sourceText: "The home page shows a banner.",
        statement: "The home page shows a banner",
        expectedOutcome: { kind: "visible", fact: { key: "banner", checkpoint: "home" }, expected: true },
        preconditions: [],
        ambiguity: null,
      },
    ],
    facts: [
      { key: "orderHistory", checkpoint: "orders_page", description: "Order history list", valueType: "boolean" },
      { key: "banner", checkpoint: "home", description: "Home page banner", valueType: "boolean" },
    ],
  });

const loginPlan = () => ({
  title: "Log in and open the order history",
  steps: [
    step("navigate", "Open the home page"),
    capture("home", ["AC-2"]),
    step("click", "Open the login page"),
    step("fill", "Enter the email address", { inputRef: { source: "testData", key: "email" } }),
    step("fill", "Enter the password", { inputRef: { source: "secret", key: "password" } }),
    step("login", "Submit the login form"),
    step("click", "Open My orders"),
    capture("orders_page", ["AC-1"]),
  ],
  stopConditions: [],
});

const DELETE_TEXT = "The settings page shows my email. Deleting the account shows a confirmation message.";

const deleteRequirement = () =>
  confirmed({
    originalText: DELETE_TEXT,
    criteria: [
      {
        id: "AC-1",
        sourceText: "The settings page shows my email.",
        statement: "The settings page shows the account email",
        expectedOutcome: { kind: "visible", fact: { key: "accountEmail", checkpoint: "settings" }, expected: true },
        preconditions: [],
        ambiguity: null,
      },
      {
        id: "AC-2",
        sourceText: "Deleting the account shows a confirmation message.",
        statement: "A confirmation message is shown after deleting the account",
        expectedOutcome: { kind: "visible", fact: { key: "deletedMessage", checkpoint: "after_delete" }, expected: true },
        preconditions: [],
        ambiguity: null,
      },
    ],
    facts: [
      { key: "accountEmail", checkpoint: "settings", description: "Account email", valueType: "boolean" },
      { key: "deletedMessage", checkpoint: "after_delete", description: "Deletion confirmation", valueType: "boolean" },
    ],
  });

const deletePlan = (deleteStep = step("click", "Click the Delete account button", { criterionIds: ["AC-2"] })) => ({
  title: "Delete the account",
  steps: [
    step("navigate", "Open the home page"),
    step("click", "Open account settings"),
    capture("settings", ["AC-1"]),
    deleteStep,
    capture("after_delete", ["AC-2"]),
  ],
  stopConditions: [],
});

function setup(...replies: FakeReply[]) {
  const transport = new FakeTransport().enqueue(...replies);
  const llm = new LlmClient({ transport, model: "claude-sonnet-5", sleep: async () => {} });
  return { transport, llm };
}

const DENY: ActionPolicy = { allowDestructive: false };

const input = (requirement: NormalizedRequirement, extra: Partial<PlanTestInput> = {}): PlanTestInput => ({
  runId: "run_1",
  requirement,
  targetUrl: "https://shop.example.com",
  testDataKeys: [],
  secretNames: [],
  policy: DENY,
  signal: new AbortController().signal,
  deadlineAt: null,
  redact: (v: unknown) => v,
  ...extra,
});

const sentText = (t: FakeTransport) => JSON.stringify(t.requests.map(({ signal: _s, ...r }) => r));
const lastCorrection = (t: FakeTransport) => JSON.stringify(t.requests.at(-1)!.messages.at(-1));
const kinds = (plan: TestPlan) => plan.scenarios[0]!.steps.map((s) => s.kind);
const checkpoints = (plan: TestPlan) =>
  plan.scenarios[0]!.steps.filter((s) => s.kind === "capture_checkpoint").map((s) => s.checkpoint);
const blocked = (plan: TestPlan) => plan.blockedCriteria.map((b) => [b.criterionId, b.reason]);

// ---------------------------------------------------------------------------------------------

describe("planTest — scenario", () => {
  it("cart requirement with 4 criteria → one scenario referencing all 4, with the expected step kinds and checkpoints", async () => {
    const { llm, transport } = setup({ json: cartPlan() });
    const plan = await planTest(llm, input(cartRequirement()));

    expect(TestPlanSchema.parse(plan)).toEqual(plan);
    expect(plan.runId).toBe("run_1");
    expect(plan.requirementRevision).toBe(2);
    expect(plan.scenarios).toHaveLength(1);
    const scenario = plan.scenarios[0]!;
    expect(scenario.id).toBe("SC-1");
    expect(scenario.criterionIds).toEqual(["AC-1", "AC-2", "AC-3", "AC-4"]);
    expect(kinds(plan)).toEqual([
      "navigate",
      "search",
      "click",
      "capture_checkpoint",
      "click",
      "capture_checkpoint",
      "click",
      "capture_checkpoint",
    ]);
    expect(checkpoints(plan)).toEqual(["before_add", "after_add", "cart_page"]);
    expect(scenario.steps.map((s) => s.id)).toEqual(["PS-1", "PS-2", "PS-3", "PS-4", "PS-5", "PS-6", "PS-7", "PS-8"]);
    // The semantic criterion (no facts) is referenced, never blocked for lacking facts.
    expect(plan.blockedCriteria).toEqual([]);
    expect(plan.stopConditions).toEqual(["The product cannot be found"]);
    expect(transport.requests).toHaveLength(1);
  });

  it("capture steps also list every criterion whose facts are read at that checkpoint", async () => {
    const out = cartPlan();
    for (const s of out.steps) s.criterionIds = [];
    const { llm } = setup({ json: out });
    const plan = await planTest(llm, input(cartRequirement()));
    const at = (cp: string) => plan.scenarios[0]!.steps.find((s) => s.checkpoint === cp)!.criterionIds;
    expect(at("before_add")).toEqual(["AC-1", "AC-2"]);
    expect(at("after_add")).toEqual(["AC-1"]);
    expect(at("cart_page")).toEqual(["AC-2", "AC-3"]);
  });

  it("the prompt carries criteria, checkpoints, testData KEYS and secret NAMES; the LLM call is attributed to PLANNING", async () => {
    const { llm, transport } = setup({ json: cartPlan() });
    await planTest(llm, input(cartRequirement(), { testDataKeys: ["quantity"], secretNames: ["password"] }));
    const sent = sentText(transport);
    for (const s of ["AC-1", "AC-4", "before_add", "after_add", "cart_page", "quantity", "password", "https://shop.example.com"]) {
      expect(sent).toContain(s);
    }
  });
});

describe("planTest — model contract (one correction round, then ContractError)", () => {
  const withoutCartPage = () => {
    const out = cartPlan();
    out.steps = out.steps.filter((s) => s.checkpoint !== "cart_page");
    return out;
  };

  it("a missing checkpoint is corrected once", async () => {
    const { llm, transport } = setup({ json: withoutCartPage() }, { json: cartPlan() });
    const plan = await planTest(llm, input(cartRequirement()));
    expect(checkpoints(plan)).toEqual(["before_add", "after_add", "cart_page"]);
    expect(transport.requests).toHaveLength(2);
    expect(lastCorrection(transport)).toMatch(/cart_page.*never captured/);
  });

  it("a checkpoint still missing after the correction → ContractError", async () => {
    const { llm, transport } = setup({ json: withoutCartPage() }, { json: withoutCartPage() }, { json: cartPlan() });
    await expect(planTest(llm, input(cartRequirement()))).rejects.toBeInstanceOf(ContractError);
    expect(transport.requests).toHaveLength(2);
  });

  it("before captured after after (numeric_delta) → correction → ContractError", async () => {
    const swapped = () => {
      const out = cartPlan();
      [out.steps[3], out.steps[5]] = [out.steps[5]!, out.steps[3]!];
      return out;
    };
    const { llm, transport } = setup({ json: swapped() }, { json: swapped() });
    await expect(planTest(llm, input(cartRequirement()))).rejects.toBeInstanceOf(ContractError);
    expect(lastCorrection(transport)).toMatch(/before_add must be captured before after_add/);
  });

  it("before_* / after_* checkpoints compared by numeric_compare must also be captured in that order", async () => {
    const req = cartRequirement();
    req.criteria[0]!.expectedOutcome = {
      kind: "numeric_compare",
      left: { key: "cartCount", checkpoint: "after_add" },
      operator: "gt",
      right: { key: "cartCount", checkpoint: "before_add" },
    };
    const swapped = cartPlan();
    [swapped.steps[3], swapped.steps[5]] = [swapped.steps[5]!, swapped.steps[3]!];
    const { llm, transport } = setup({ json: swapped }, { json: cartPlan() });
    await planTest(llm, input(req));
    expect(lastCorrection(transport)).toMatch(/before_add must be captured before after_add/);
  });

  it("a hallucinated criterion id → correction → ContractError", async () => {
    const bad = () => {
      const out = cartPlan();
      out.steps[4]!.criterionIds = ["AC-9"];
      return out;
    };
    const { llm, transport } = setup({ json: bad() }, { json: bad() });
    await expect(planTest(llm, input(cartRequirement()))).rejects.toBeInstanceOf(ContractError);
    expect(transport.requests).toHaveLength(2);
    expect(lastCorrection(transport)).toMatch(/unknown criterion id AC-9/);
  });

  it("capture_checkpoint without a checkpoint is corrected", async () => {
    const bad = cartPlan();
    bad.steps.splice(1, 0, step("capture_checkpoint", "Capture something"));
    const { llm, transport } = setup({ json: bad }, { json: cartPlan() });
    await planTest(llm, input(cartRequirement()));
    expect(lastCorrection(transport)).toMatch(/steps\.1\.checkpoint.*required/);
  });

  it("a checkpoint captured twice is corrected", async () => {
    const bad = cartPlan();
    bad.steps.push(capture("cart_page"));
    const { llm, transport } = setup({ json: bad }, { json: cartPlan() });
    await planTest(llm, input(cartRequirement()));
    expect(lastCorrection(transport)).toMatch(/cart_page is captured more than once/);
  });

  it("a fill step without an inputRef (a value the platform could not supply) → correction → ContractError", async () => {
    const bad = () => {
      const out = loginPlan();
      out.steps[4]!.inputRef = null; // "Enter the password" with no secret reference
      return out;
    };
    const { llm, transport } = setup({ json: bad() }, { json: bad() });
    await expect(planTest(llm, input(loginRequirement(), { testDataKeys: ["email"], secretNames: [] }))).rejects.toBeInstanceOf(
      ContractError,
    );
    expect(transport.requests).toHaveLength(2);
    expect(lastCorrection(transport)).toMatch(/steps\.4\.inputRef.*required when kind = fill/);
  });

  it("a fill step without an inputRef is corrected once, and the corrected plan still blocks MISSING_SECRET", async () => {
    const bad = loginPlan();
    bad.steps[4]!.inputRef = null;
    const { llm } = setup({ json: bad }, { json: loginPlan() });
    const plan = await planTest(llm, input(loginRequirement(), { testDataKeys: ["email"], secretNames: [] }));
    expect(blocked(plan)).toEqual([["AC-1", "MISSING_SECRET"]]);
  });

  it("more than one login step → correction → ContractError", async () => {
    const bad = () => {
      const out = loginPlan();
      out.steps.splice(6, 0, step("login", "Submit the login form again"));
      return out;
    };
    const { llm, transport } = setup({ json: bad() }, { json: bad() });
    await expect(planTest(llm, input(loginRequirement(), { testDataKeys: ["email"], secretNames: ["password"] }))).rejects.toBeInstanceOf(
      ContractError,
    );
    expect(lastCorrection(transport)).toMatch(/2 login steps.*at most one/);
  });

  it("more than 50 steps → correction → ContractError", async () => {
    const long = () => {
      const out = cartPlan();
      out.steps.splice(1, 0, ...Array.from({ length: 50 }, (_, i) => step("wait_for", `Wait for the page ${i}`)));
      return out;
    };
    const { llm, transport } = setup({ json: long() }, { json: long() });
    await expect(planTest(llm, input(cartRequirement()))).rejects.toBeInstanceOf(ContractError);
    expect(transport.requests).toHaveLength(2);
  });
});

describe("planTest — deterministic blocking", () => {
  it("inputRef to a secret name that was not provided → MISSING_SECRET for criteria that depend on that step only", async () => {
    const { llm } = setup({ json: loginPlan() });
    const plan = await planTest(llm, input(loginRequirement(), { testDataKeys: ["email"], secretNames: [] }));
    expect(blocked(plan)).toEqual([["AC-1", "MISSING_SECRET"]]);
    expect(plan.blockedCriteria[0]!.detail).toMatch(/password/);
    // AC-2's checkpoint is captured before the login steps: not affected.
    expect(kinds(plan)).toContain("login");
  });

  it("inputRef to a test data key that was not provided → MISSING_TEST_DATA", async () => {
    const { llm } = setup({ json: loginPlan() });
    const plan = await planTest(llm, input(loginRequirement(), { testDataKeys: [], secretNames: ["password"] }));
    expect(blocked(plan)).toEqual([["AC-1", "MISSING_TEST_DATA"]]);
    expect(plan.blockedCriteria[0]!.detail).toMatch(/email/);
  });

  it("nothing blocked when the secret and test data are provided", async () => {
    const { llm } = setup({ json: loginPlan() });
    const plan = await planTest(llm, input(loginRequirement(), { testDataKeys: ["email"], secretNames: ["password"] }));
    expect(plan.blockedCriteria).toEqual([]);
  });

  it("a secret precondition that was not provided blocks the criterion even if no step references it", async () => {
    const out = loginPlan();
    out.steps = out.steps.filter((s) => s.kind !== "fill");
    const { llm } = setup({ json: out });
    const req = loginRequirement([{ kind: "secret", ref: "admin_token", description: "Admin token" }]);
    const plan = await planTest(llm, input(req, { secretNames: ["password"] }));
    expect(blocked(plan)).toEqual([["AC-1", "MISSING_SECRET"]]);
    expect(plan.blockedCriteria[0]!.detail).toMatch(/admin_token/);
  });

  it("a step that fails assertActionAllowed truncates the scenario; criteria at or after it → DESTRUCTIVE_ACTION_NOT_AUTHORIZED", async () => {
    const { llm } = setup({ json: deletePlan() });
    const plan = await planTest(llm, input(deleteRequirement()));
    expect(kinds(plan)).toEqual(["navigate", "click", "capture_checkpoint"]);
    expect(blocked(plan)).toEqual([["AC-2", "DESTRUCTIVE_ACTION_NOT_AUTHORIZED"]]);
    expect(plan.blockedCriteria[0]!.detail).toMatch(/"delete"/);
    expect(TestPlanSchema.safeParse(plan).success).toBe(true);
  });

  it("\"Verify that account deletion works\" is blocked by the policy itself, even when the model says destructive=false", async () => {
    const { llm } = setup({
      json: deletePlan(step("click", "Verify that account deletion works", { criterionIds: ["AC-2"], destructive: false })),
    });
    const plan = await planTest(llm, input(deleteRequirement()));
    expect(kinds(plan)).toHaveLength(3);
    expect(blocked(plan)).toEqual([["AC-2", "DESTRUCTIVE_ACTION_NOT_AUTHORIZED"]]);
    expect(plan.blockedCriteria[0]!.detail).toMatch(/"deletion"/);
  });

  it("cancelling an order is blocked by the policy itself, even when the model says destructive=false", async () => {
    const { llm } = setup({ json: deletePlan(step("click", "Click Cancel my order", { criterionIds: ["AC-2"], destructive: false })) });
    const plan = await planTest(llm, input(deleteRequirement()));
    expect(blocked(plan)).toEqual([["AC-2", "DESTRUCTIVE_ACTION_NOT_AUTHORIZED"]]);
    expect(plan.blockedCriteria[0]!.detail).toMatch(/"cancel my order"/);
  });

  it("the model's destructive flag adds blocking for a step no policy term matches", async () => {
    const { llm } = setup({
      json: deletePlan(step("click", "Confirm the irreversible action", { criterionIds: ["AC-2"], destructive: true })),
    });
    const plan = await planTest(llm, input(deleteRequirement()));
    expect(kinds(plan)).toHaveLength(3);
    expect(blocked(plan)).toEqual([["AC-2", "DESTRUCTIVE_ACTION_NOT_AUTHORIZED"]]);
    expect(plan.blockedCriteria[0]!.detail).toMatch(/marked destructive/);
  });

  it("the model saying destructive=false never un-blocks a step the policy denies", async () => {
    const { llm } = setup({ json: deletePlan(step("click", "Click Delete account", { destructive: false })) });
    const plan = await planTest(llm, input(deleteRequirement()));
    expect(blocked(plan)).toEqual([["AC-2", "DESTRUCTIVE_ACTION_NOT_AUTHORIZED"]]);
  });

  it("with destructive actions allowed the scenario is kept whole and the step is flagged destructive", async () => {
    const { llm } = setup({ json: deletePlan() });
    const plan = await planTest(llm, input(deleteRequirement(), { policy: { allowDestructive: true } }));
    expect(plan.blockedCriteria).toEqual([]);
    expect(plan.scenarios[0]!.steps).toHaveLength(5);
    expect(plan.scenarios[0]!.steps[3]!.destructive).toBe(true);
  });

  it("truncation down to zero steps keeps a valid plan (one navigate to the target) with every criterion blocked", async () => {
    const out = deletePlan();
    out.steps = [step("click", "Click the Delete account button"), ...out.steps];
    const { llm } = setup({ json: out });
    const plan = await planTest(llm, input(deleteRequirement()));
    expect(TestPlanSchema.safeParse(plan).success).toBe(true);
    expect(plan.scenarios[0]!.steps).toEqual([
      { id: "PS-1", kind: "navigate", description: "Open https://shop.example.com", criterionIds: [], destructive: false },
    ]);
    expect(blocked(plan)).toEqual([
      ["AC-1", "DESTRUCTIVE_ACTION_NOT_AUTHORIZED"],
      ["AC-2", "DESTRUCTIVE_ACTION_NOT_AUTHORIZED"],
    ]);
  });
});

describe("planTest — secrets", () => {
  it("with a secret present, no value reaches the transport or the plan (even if the model echoes it)", async () => {
    const secret = "pw-Very-Secret-77";
    const req = confirmed({ ...loginRequirement(), originalText: `${LOGIN_TEXT} Use password ${secret}.` });
    const leaky = loginPlan();
    leaky.steps[4]!.description = `Enter the password ${secret}`;
    const { llm, transport } = setup({ json: leaky });

    const plan = await planTest(
      llm,
      input(req, { testDataKeys: ["email"], secretNames: ["password"], redact: createRunRedactor([secret]) }),
    );

    expect(sentText(transport)).not.toContain(secret);
    expect(JSON.stringify(plan)).not.toContain(secret);
    expect(plan.scenarios[0]!.steps[4]!.inputRef).toEqual({ source: "secret", key: "password" });
  });
});

// ---------------------------------------------------------------------------------------------

function stageContext(request: StoredTestRunRequest, secrets: Record<string, string> = {}): StageContext {
  const ac = new AbortController();
  return {
    runId: "run_1",
    tenantId: "t_default",
    request,
    signal: ac.signal,
    deadlineAt: null,
    budgets: { explorationMs: 1000, rerunMs: 1000 },
    secrets: { names: Object.keys(secrets), get: (n) => secrets[n] },
    redact: createRunRedactor(Object.values(secrets)),
    publish: async () => {},
    addCleanup: () => {},
    boundary: async () => {},
    budgetSignal: () => ac.signal,
    now: () => new Date(),
  };
}

const storedRequest = (
  environment: StoredTestRunRequest["environment"],
  allowDestructiveActions: boolean,
  testData: StoredTestRunRequest["testData"] = {},
): StoredTestRunRequest => ({
  targetUrl: "https://shop.example.com",
  requirement: DELETE_TEXT,
  environment,
  browser: "chromium",
  testData,
  secretNames: [],
  options: {
    maxExplorationSteps: 40,
    maxRunSeconds: 300,
    generatePlaywright: true,
    rerunGeneratedTest: true,
    autoConfirmCriteria: false,
    allowDestructiveActions,
    additionalAllowedHosts: [],
  },
});

describe("actionPolicyFor (D9)", () => {
  it.each([
    ["staging", false, false],
    ["staging", true, true],
    ["production", true, false],
    ["production", false, false],
  ] as const)("%s, allowDestructiveActions=%s → allowDestructive=%s", (env, allow, expected) => {
    expect(actionPolicyFor(storedRequest(env, allow))).toEqual({ allowDestructive: expected });
  });
});

describe("createPlanStage", () => {
  it("production blocks destructive steps even when allowDestructiveActions is on", async () => {
    const { llm } = setup({ json: deletePlan() });
    const plan = await createPlanStage(llm)(stageContext(storedRequest("production", true)), deleteRequirement());
    expect(blocked(plan)).toEqual([["AC-2", "DESTRUCTIVE_ACTION_NOT_AUTHORIZED"]]);
  });

  it("reads testData keys (not values) and secret names from the context", async () => {
    const secret = "pw-Stage-Secret-5";
    const { llm, transport } = setup({ json: loginPlan() });
    const ctx = stageContext(storedRequest("staging", false, { email: "alice.tester@example.com" }), { password: secret });
    const plan = await createPlanStage(llm)(ctx, loginRequirement());
    expect(plan.blockedCriteria).toEqual([]);
    const sent = sentText(transport);
    expect(sent).toContain("email");
    expect(sent).not.toContain("alice.tester@example.com");
    expect(sent).not.toContain(secret);
  });
});

// ---------------------------------------------------------------------------------------------

function executionPorts(requirement: NormalizedRequirement) {
  const events: EventDraft[] = [];
  const transitions: RunLifecycle[] = [];
  let lifecycle: RunLifecycle = "PLANNING";
  let saved: TestPlan | null = null;
  let results: ProvisionalResult[] = [];
  const ports: RunPorts = {
    lifecycle: () => lifecycle,
    transition: async (to) => {
      transitions.push(to);
      lifecycle = to;
    },
    publish: async (e) => {
      events.push(e);
    },
    saveRequirement: async () => requirement,
    confirmRequirement: async () => requirement,
    getConfirmedRequirement: async () => requirement,
    savePlan: async (plan) => {
      saved = TestPlanSchema.parse(plan);
    },
    saveResults: async (r) => {
      results = r;
    },
    enqueueExecute: async () => {},
  };
  return { ports, events, transitions, saved: () => saved, results: () => results };
}

/** Real analyze/plan stages; exploration stays fake here (the real explore stage is tested in exploration/). */
function realPlanStages(llm: Parameters<typeof createRealStages>[0]["llm"]) {
  const fake = createFakeStages();
  const unused = { openSandbox: async () => ({}) as never, explorer: { start: async () => ({}) as never }, store: () => ({}) as never };
  // No rerun here: a proxy that cannot start makes the rerun ERRORED without running anything.
  const noRerun = { openProxy: async () => Promise.reject(new Error("no rerun")), spawn: async () => ({}) as never, workspace: { baseDir: "/nonexistent" }, evidence: () => ({}) as never };
  const report = { store: () => ({ saveDiagnostics: async () => {}, llmUsage: async () => [] }) };
  return { ...createRealStages({ llm, exploration: unused, generateTest: { store: () => ({ save: async () => {} }) }, runTest: noRerun, report }), explore: fake.explore };
}

describe("plan stage behind runExecution (real planner, fake later stages)", () => {
  it("persists the planner's plan and publishes plan.created with its step count and blocked criteria", async () => {
    const { llm } = setup({ json: loginPlan() });
    const p = executionPorts(loginRequirement());
    await runExecution(stageContext(storedRequest("staging", false, { email: "a@example.com" })), p.ports, realPlanStages(llm));

    expect(kinds(p.saved()!)).toContain("login");
    const created = p.events.find((e) => e.type === "plan.created")!;
    expect(created.message).toBe("Plan created with 8 steps");
    expect(created.payload).toEqual({ stepCount: 8, blockedCriteria: [{ criterionId: "AC-1", reason: "MISSING_SECRET" }] });
    expect(p.transitions[0]).toBe("EXPLORING");
  });

  it("every criterion blocked by policy → PLANNING goes straight to GENERATING_REPORT", async () => {
    const out = deletePlan();
    out.steps = [step("click", "Click the Delete account button"), ...out.steps];
    const { llm } = setup({ json: out });
    const p = executionPorts(deleteRequirement());
    await runExecution(stageContext(storedRequest("production", true)), p.ports, realPlanStages(llm));

    expect(p.transitions).toEqual(["GENERATING_REPORT", "COMPLETED"]);
    expect(p.saved()!.scenarios[0]!.steps).toHaveLength(1);
    expect(p.results().map((r) => [r.criterionId, r.status, r.reason])).toEqual([
      ["AC-1", "BLOCKED", "DESTRUCTIVE_ACTION_NOT_AUTHORIZED"],
      ["AC-2", "BLOCKED", "DESTRUCTIVE_ACTION_NOT_AUTHORIZED"],
    ]);
  });
});
