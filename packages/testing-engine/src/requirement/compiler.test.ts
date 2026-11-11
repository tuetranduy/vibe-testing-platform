import {
  ContractError,
  NormalizedRequirementSchema,
  type NormalizedRequirement,
  type RunLifecycle,
  type StoredTestRunRequest,
  type TestDataValue,
} from "@platform/contracts";
import { FakeTransport, LlmClient, type FakeReply } from "@platform/llm";
import { createRunRedactor } from "@platform/security";
import { describe, expect, it } from "vitest";
import { runAnalysis, type RunPorts } from "../orchestrator/orchestrator";
import { createRealStages } from "../orchestrator/real-stages";
import type { EventDraft, RequirementDraft, StageContext } from "../orchestrator/stages";
import { compileRequirement, createAnalyzeStage } from "./compiler";
import { THRESHOLD_NOT_STATED } from "./post-validate";

/** A redactor that masks the given values: the run's redactor is key-based, but the plumbing applies whatever it is given. */
const maskValues =
  (...values: string[]) =>
  (v: unknown): unknown =>
    JSON.parse(values.reduce((json, s) => json.split(s).join("[REDACTED]"), JSON.stringify(v) ?? "null"));

const CART_TEXT = "A user can add a product to the cart. The cart count should increase.";

/** What a well-behaved model returns for CART_TEXT. */
const cartOutput = () => ({
  criteria: [
    {
      sourceText: "A user can add a product to the cart.",
      statement: "The product appears in the cart after adding it",
      expectedOutcome: {
        kind: "collection_contains",
        collection: { key: "cartItems", checkpoint: "after_add" },
        item: { key: "productName", checkpoint: "product_page" },
        match: "contains",
      },
      preconditions: [],
      ambiguity: null,
    },
    {
      sourceText: "The cart count should increase.",
      statement: "The cart count increases after adding a product",
      expectedOutcome: {
        kind: "numeric_compare",
        left: { key: "cartCount", checkpoint: "after_add" },
        operator: "gt",
        right: { key: "cartCount", checkpoint: "before_add" },
      },
      preconditions: [],
      ambiguity: null,
    },
  ],
  facts: [
    { key: "productName", checkpoint: "product_page", description: "Name of the product being added", valueType: "string" },
    { key: "cartItems", checkpoint: "after_add", description: "Names of the items in the cart", valueType: "string_list" },
    { key: "cartCount", checkpoint: "before_add", description: "Cart badge count", valueType: "number" },
    { key: "cartCount", checkpoint: "after_add", description: "Cart badge count", valueType: "number" },
  ],
});

function setup(...replies: FakeReply[]) {
  const transport = new FakeTransport().enqueue(...replies);
  const llm = new LlmClient({ transport, model: "claude-sonnet-5", sleep: async () => {} });
  return { transport, llm };
}

const input = (originalText: string, extra: { testData?: Record<string, TestDataValue>; secretNames?: string[] } = {}) => ({
  runId: "run_1",
  originalText,
  testData: extra.testData ?? {},
  secretNames: extra.secretNames ?? [],
  signal: new AbortController().signal,
  deadlineAt: null,
  redact: (v: unknown) => v,
});

/** Persisting a draft must succeed with the shared schema (what the orchestrator does). */
const persist = (draft: RequirementDraft): NormalizedRequirement =>
  NormalizedRequirementSchema.parse({ ...draft, runId: "run_1", revision: 1, confirmedAt: null });

const sentText = (t: FakeTransport) => JSON.stringify(t.requests.map(({ signal: _s, ...r }) => r));

describe("compileRequirement", () => {
  it("refuses an empty requirement (a blank run chooses a suggested test first): ContractError, no model call", async () => {
    const { llm, transport } = setup({ json: cartOutput() });
    await expect(compileRequirement(llm, input("   "))).rejects.toBeInstanceOf(ContractError);
    expect(transport.requests).toHaveLength(0);
  });

  it("add-to-cart: 2 criteria → AC-1, AC-2; originalText unchanged; structured kinds; every FactRef declared", async () => {
    const { llm } = setup({ json: cartOutput() });
    const draft = await compileRequirement(llm, input(CART_TEXT));

    expect(draft.originalText).toBe(CART_TEXT);
    expect(draft.criteria.map((c) => c.id)).toEqual(["AC-1", "AC-2"]);
    expect(draft.criteria.map((c) => c.expectedOutcome.kind)).toEqual(["collection_contains", "numeric_compare"]);
    expect(draft.criteria.every((c) => c.ambiguity === null)).toBe(true);
    const saved = persist(draft); // throws if a FactRef is undeclared or sourceText is not verbatim
    expect(saved.facts).toHaveLength(4);
  });

  it("sourceText not a substring of originalText → one correction retry naming the problem", async () => {
    const bad = cartOutput();
    bad.criteria[1]!.sourceText = "The cart counter goes up.";
    const { llm, transport } = setup({ json: bad }, { json: cartOutput() });

    const draft = await compileRequirement(llm, input(CART_TEXT));

    expect(draft.criteria[1]!.sourceText).toBe("The cart count should increase.");
    expect(transport.requests).toHaveLength(2);
    expect(JSON.stringify(transport.requests[1]!.messages.at(-1))).toMatch(/criteria\.1\.sourceText.*verbatim/);
  });

  it("sourceText still not verbatim after the correction → that criterion is left out, the others are kept (2026-11-11)", async () => {
    const bad = cartOutput();
    bad.criteria[0]!.sourceText = "Users add products.";
    const { llm, transport } = setup({ json: bad }, { json: bad }, { json: cartOutput() });
    const draft = await compileRequirement(llm, input(CART_TEXT));
    expect(transport.requests).toHaveLength(2); // at most one correction round per compile
    expect(draft.criteria.map((c) => [c.id, c.statement])).toEqual([["AC-1", "The cart count increases after adding a product"]]);
    expect(draft.facts.map((f) => `${f.key}@${f.checkpoint}`)).toEqual(["cartCount@before_add", "cartCount@after_add"]);
    expect(draft.intent?.notes).toEqual(["Left out: The product appears in the cart after adding it (could not be turned into a check)"]);
    persist(draft);
  });

  it("every criterion still invalid after the correction → the requirement is judged as a whole, never an errored run", async () => {
    const bad = cartOutput();
    bad.criteria[0]!.sourceText = "Users add products.";
    bad.criteria[1]!.sourceText = "The counter goes up.";
    const { llm } = setup({ json: bad }, { json: bad });
    const draft = await compileRequirement(llm, input(CART_TEXT));
    expect(draft.criteria).toHaveLength(1);
    expect(draft.criteria[0]).toMatchObject({ id: "AC-1", sourceText: CART_TEXT, expectedOutcome: { kind: "semantic", description: CART_TEXT }, critical: true });
    expect(draft.facts).toEqual([]);
    expect(draft.intent?.notes.at(-1)).toMatch(/judged as a whole/);
    persist(draft);
  });

  it("an answer that does not match the output schema after the correction is still a ContractError", async () => {
    const { llm, transport } = setup({ json: { criteria: "none" } }, { json: { criteria: "none" } });
    await expect(compileRequirement(llm, input(CART_TEXT))).rejects.toBeInstanceOf(ContractError);
    expect(transport.requests).toHaveLength(2);
  });

  it("an undeclared FactRef is corrected the same way", async () => {
    const bad = cartOutput();
    bad.facts = bad.facts.filter((f) => f.checkpoint !== "before_add");
    const { llm, transport } = setup({ json: bad }, { json: cartOutput() });
    await compileRequirement(llm, input(CART_TEXT));
    expect(JSON.stringify(transport.requests[1]!.messages.at(-1))).toMatch(/cartCount@before_add is not declared/);
  });

  it('"The page should be fast." → an invented threshold becomes semantic with an ambiguity', async () => {
    const text = "The page should be fast.";
    const { llm, transport } = setup({
      json: {
        criteria: [
          {
            sourceText: text,
            statement: "The page loads in under 2000 ms",
            expectedOutcome: { kind: "numeric_compare", left: { key: "loadTimeMs", checkpoint: "page_loaded" }, operator: "lt", right: 2000 },
            preconditions: [],
            ambiguity: null,
          },
        ],
        facts: [{ key: "loadTimeMs", checkpoint: "page_loaded", description: "Page load time in ms", valueType: "number" }],
      },
    });

    const draft = await compileRequirement(llm, input(text));

    expect(transport.requests).toHaveLength(1); // a deterministic rewrite, not a correction round
    const c = draft.criteria[0]!;
    // The requirement's own words become the (AI-judged) outcome; the invented number survives
    // only as a suggestion the user can accept at confirmation.
    expect(c.expectedOutcome).toEqual({ kind: "semantic", description: text });
    expect(c.ambiguity).toEqual({ reason: THRESHOLD_NOT_STATED, suggestions: ["The page loads in under 2000 ms"] });
    expect(draft.facts).toEqual([]); // the orphaned fact is dropped
    persist(draft);
  });

  it("numbers stated in the requirement or in testData values are kept", async () => {
    const text = "Search results appear within 3 seconds. The cart holds at most 5 items.";
    const { llm } = setup({
      json: {
        criteria: [
          {
            sourceText: "Search results appear within 3 seconds.",
            statement: "Results appear within 3 seconds",
            expectedOutcome: { kind: "numeric_compare", left: { key: "resultsSeconds", checkpoint: "searched" }, operator: "lte", right: 3 },
            preconditions: [],
            ambiguity: null,
          },
          {
            sourceText: "The cart holds at most 5 items.",
            statement: "The cart shows the quantity from test data",
            expectedOutcome: { kind: "numeric_compare", left: { key: "cartCount", checkpoint: "filled" }, operator: "eq", right: 12 },
            preconditions: [{ kind: "test_data", ref: "quantity", description: "Quantity to add" }],
            ambiguity: null,
          },
        ],
        facts: [
          { key: "resultsSeconds", checkpoint: "searched", description: "Seconds until results render", valueType: "number" },
          { key: "cartCount", checkpoint: "filled", description: "Cart badge count", valueType: "number" },
        ],
      },
    });
    const draft = await compileRequirement(llm, input(text, { testData: { quantity: "12" } }));
    expect(draft.criteria.map((c) => c.expectedOutcome.kind)).toEqual(["numeric_compare", "numeric_compare"]);
    expect(draft.criteria.every((c) => c.ambiguity === null)).toBe(true);
  });

  it("a precondition referencing a secret name that was not provided is kept (the planner blocks it)", async () => {
    const text = "A logged-in user sees their order history.";
    const { llm } = setup({
      json: {
        criteria: [
          {
            sourceText: text,
            statement: "The order history is visible after login",
            expectedOutcome: { kind: "visible", fact: { key: "orderHistory", checkpoint: "account_page" }, expected: true },
            preconditions: [
              { kind: "authenticated", description: "User is logged in" },
              { kind: "secret", ref: "password", description: "Account password" },
            ],
            ambiguity: null,
          },
        ],
        facts: [{ key: "orderHistory", checkpoint: "account_page", description: "Order history section", valueType: "boolean" }],
      },
    });
    const draft = await compileRequirement(llm, input(text, { secretNames: [] }));
    expect(draft.criteria[0]!.preconditions).toEqual([
      { kind: "authenticated", description: "User is logged in" },
      { kind: "secret", ref: "password", description: "Account password" },
    ]);
  });

  it("only secret NAMES and testData KEYS reach the prompt — never their values", async () => {
    const secret = "S3cr3t-Value-991";
    const text = `Log in as admin with password ${secret} first. The dashboard should show a welcome message.`;
    const { llm, transport } = setup({
      json: {
        criteria: [
          {
            sourceText: "The dashboard should show a welcome message.",
            statement: "A welcome message is shown on the dashboard",
            expectedOutcome: { kind: "visible", fact: { key: "welcomeMessage", checkpoint: "dashboard" }, expected: true },
            preconditions: [{ kind: "secret", ref: "admin_password", description: "Admin password" }],
            ambiguity: null,
          },
        ],
        facts: [{ key: "welcomeMessage", checkpoint: "dashboard", description: "Welcome message", valueType: "boolean" }],
      },
    });

    await compileRequirement(llm, {
      ...input(text, { testData: { username: "alice.tester@example.com" }, secretNames: ["admin_password"] }),
      redact: maskValues(secret),
    });

    const sent = sentText(transport);
    expect(sent).toContain("admin_password");
    expect(sent).toContain("username");
    expect(sent).not.toContain(secret);
    expect(sent).not.toContain("alice.tester@example.com");
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
    redact: createRunRedactor(),
    publish: async () => {},
    addCleanup: () => {},
    boundary: async () => {},
    budgetSignal: () => ac.signal,
    now: () => new Date(),
    llm: null,
  };
}

const storedRequest = (requirement: string, testData: Record<string, TestDataValue> = {}, secretNames: string[] = []): StoredTestRunRequest => ({
  targetUrl: "https://shop.example.com",
  requirement,
  environment: "staging",
  browser: "chromium",
  testData,
  secretNames,
  options: {
    maxExplorationSteps: 40,
    maxRunSeconds: 300,
    generatePlaywright: true,
    rerunGeneratedTest: true,
    autoConfirmCriteria: false,
    allowDestructiveActions: false,
    additionalAllowedHosts: [],
  },
});

function fakePorts() {
  const events: EventDraft[] = [];
  let lifecycle: RunLifecycle = "QUEUED";
  let saved: NormalizedRequirement | null = null;
  const ports: RunPorts = {
    lifecycle: () => lifecycle,
    transition: async (to) => {
      lifecycle = to;
    },
    publish: async (e) => {
      events.push(e);
    },
    saveRequirement: async (draft) => (saved = persist(draft)),
    confirmRequirement: async () => saved!,
    getConfirmedRequirement: async () => saved!,
    savePlan: async () => {},
    saveResults: async () => {},
    enqueueExecute: async () => {},
    getGeneratedTest: async () => {
      throw new Error("no generated test in this test");
    },
    saveSuggestions: async () => {
      throw new Error("not used by these tests");
    },
    saveSiteAnalysis: async () => {},
    applyTestData: async () => {},
    getSiteAnalysis: async () => null,
  };
  return { ports, events, saved: () => saved, lifecycle: () => lifecycle };
}

describe("analyze stage (real compiler behind runAnalysis)", () => {
  it("publishes stage.started, criteria.proposed (\"2 acceptance criteria identified\"), stage.completed — no model reasoning", async () => {
    const reasoning = "INTERNAL-CHAIN-OF-THOUGHT: the user probably means the badge";
    const { llm } = setup({ json: { ...cartOutput(), reasoning } });
    const unusedExploration = { openSandbox: async () => ({}) as never, explorer: { start: async () => ({}) as never }, store: () => ({}) as never };
    const unusedRerun = { openProxy: async () => ({}) as never, spawn: async () => ({}) as never, workspace: { baseDir: "/nonexistent" }, evidence: () => ({}) as never };
    const unusedReport = { store: () => ({}) as never };
    const stages = createRealStages({ survey: { openSandbox: async () => ({}) as never, store: () => ({}) as never }, exploration: unusedExploration, generateTest: { store: () => ({ save: async () => {} }) }, runTest: unusedRerun, report: unusedReport });
    const p = fakePorts();

    await runAnalysis({ ...stageContext(storedRequest(CART_TEXT)), llm }, p.ports, stages);

    expect(p.events.map((e) => e.type)).toEqual(["stage.started", "criteria.proposed", "stage.completed"]);
    expect(p.events[1]!.message).toBe("2 acceptance criteria identified");
    expect(JSON.stringify(p.events)).not.toContain(reasoning);
    expect(p.saved()!.criteria.map((c) => c.id)).toEqual(["AC-1", "AC-2"]);
    expect(p.lifecycle()).toBe("AWAITING_CONFIRMATION");
  });

  it("the stage reads testData values and secret names from the context; a secret written in the requirement is not redacted", async () => {
    const secret = "pw-Very-Secret-77";
    const { llm, transport } = setup({ json: cartOutput() });
    const ctx = stageContext(storedRequest(`${CART_TEXT} Use password ${secret}.`, { sku: "SKU-4471" }, ["password"]), {
      password: secret,
    });

    await createAnalyzeStage()({ ...ctx, llm });

    const sent = sentText(transport);
    expect(sent).toContain("password");
    expect(sent).toContain("sku");
    expect(sent).toContain(secret);
    expect(sent).not.toContain("SKU-4471");
  });
});


describe("summarized test titles", () => {
  it("obtains a title in the criteria call and preserves the full requirement", async () => {
    const { llm, transport } = setup({ json: { ...cartOutput(), title: "Verify cart count after adding a product" } });
    const draft = await compileRequirement(llm, input(CART_TEXT));
    expect(draft.title).toBe("Verify cart count after adding a product");
    expect(draft.originalText).toBe(CART_TEXT);
    expect(persist(draft).title).toBe(draft.title);
    expect(transport.requests).toHaveLength(1);
  });

  it("redacts title content and supports old model responses without a title", async () => {
    const secret = "private-value";
    const { llm } = setup({ json: { ...cartOutput(), title: `Cart ${secret}` } });
    const draft = await compileRequirement(llm, { ...input(CART_TEXT), redact: maskValues(secret) });
    expect(draft.title).toBe("Cart [REDACTED]");
    const old = setup({ json: cartOutput() });
    expect((await compileRequirement(old.llm, input(CART_TEXT))).title).toBeUndefined();
  });
});


describe("compileRequirement: intent and inferred criteria (2026-11-11)", () => {
  const SEARCH_TEXT = "Test the search";
  const page = {
    url: "https://shop.test/",
    inventory: { title: "Shop", description: "", headings: [], links: [], forms: [{ name: "Search", fields: [{ label: "Search", type: "search", placeholder: "Search products" }], submit: "" }], buttons: [] },
  };
  const site = { pages: [page], screenshot: null };
  const visible = (key: string, checkpoint: string, extra: Record<string, unknown> = {}) => ({
    sourceText: SEARCH_TEXT,
    statement: `The ${key} is shown`,
    expectedOutcome: { kind: "visible", fact: { key, checkpoint }, expected: true },
    preconditions: [],
    ambiguity: null,
    ...extra,
  });
  const fact = (key: string, checkpoint: string) => ({ key, checkpoint, description: `Whether the ${key} is shown`, valueType: "boolean" });
  const searchOutput = () => ({
    title: "Search finds products",
    intent: { clarity: "feature", goal: "A visitor can search the shop and get matching products", feature: "Search" },
    criteria: [
      visible("searchField", "home"),
      visible("matchingProduct", "results", { origin: "inferred", rationale: "A search that works lists a product the shop sells" }),
      visible("emptyState", "no_results", { origin: "inferred", rationale: "A search that matches nothing should say so" }),
    ],
    facts: [fact("searchField", "home"), fact("matchingProduct", "results"), fact("emptyState", "no_results")],
    siteChecks: [1, 2, 3].map((criterion) => ({ criterion, status: "found", note: `The home page has a search field (${criterion})` })),
  });

  it("keeps grounded inferred criteria with their rationale, and returns the intent", async () => {
    const { llm, transport } = setup({ json: searchOutput() });
    const draft = await compileRequirement(llm, { ...input(SEARCH_TEXT), site });
    expect(transport.requests).toHaveLength(1);
    expect(draft.criteria.map((c) => [c.id, c.origin ?? "stated", c.rationale ?? null])).toEqual([
      ["AC-1", "stated", null],
      ["AC-2", "inferred", "A search that works lists a product the shop sells"],
      ["AC-3", "inferred", "A search that matches nothing should say so"],
    ]);
    expect(draft.criteria.every((c) => c.critical)).toBe(true);
    expect(draft.intent).toEqual({ clarity: "feature", goal: "A visitor can search the shop and get matching products", feature: "Search", notes: [] });
    expect(draft.insights.checks.map((c) => c.criterionId)).toEqual(["AC-1", "AC-2", "AC-3"]);
    persist(draft);
  });

  it("without pages read the inferred criteria are left out, and that costs no correction round", async () => {
    const { llm, transport } = setup({ json: searchOutput() });
    const draft = await compileRequirement(llm, input(SEARCH_TEXT));
    expect(transport.requests).toHaveLength(1);
    expect(draft.criteria.map((c) => c.statement)).toEqual(["The searchField is shown"]);
    expect(draft.facts).toHaveLength(1);
    expect(draft.intent?.notes).toEqual([
      "Left out: The matchingProduct is shown (no pages of the site were read)",
      "Left out: The emptyState is shown (no pages of the site were read)",
    ]);
    persist(draft);
  });

  it("an invalid inferred criterion is left out without a correction round when the rest is valid", async () => {
    const out = searchOutput();
    out.siteChecks[2]!.status = "not_found";
    out.facts.pop(); // the dropped criterion's fact is not even declared
    const { llm, transport } = setup({ json: out });
    const draft = await compileRequirement(llm, { ...input(SEARCH_TEXT), site });
    expect(transport.requests).toHaveLength(1);
    expect(draft.criteria).toHaveLength(2);
    expect(draft.insights.checks.map((c) => c.criterionId)).toEqual(["AC-1", "AC-2"]);
  });

  it("a grounded added check that is invalid in itself is left out at once: the correction round is for the user's own criteria", async () => {
    const out = searchOutput();
    out.facts.pop(); // AC-3 (added) reads a fact that is not declared
    const { llm, transport } = setup({ json: out });
    const draft = await compileRequirement(llm, { ...input(SEARCH_TEXT), site });
    expect(transport.requests).toHaveLength(1);
    expect(draft.criteria.map((c) => c.id)).toEqual(["AC-1", "AC-2"]);
    expect(draft.intent?.notes).toEqual(["Left out: The emptyState is shown (could not be turned into a check)"]);
  });

  it("an invalid stated criterion still gets its correction round, even next to an invalid added one", async () => {
    const bad = searchOutput();
    bad.facts.shift(); // AC-1 (stated) reads an undeclared fact
    const { llm, transport } = setup({ json: bad }, { json: searchOutput() });
    const draft = await compileRequirement(llm, { ...input(SEARCH_TEXT), site });
    expect(transport.requests).toHaveLength(2);
    expect(draft.criteria).toHaveLength(3);
  });

  it("only inferred criteria for a requirement the model calls specific → judged as a whole", async () => {
    const out = searchOutput();
    out.intent.clarity = "specific";
    out.criteria.shift();
    out.facts.shift();
    const { llm } = setup({ json: out });
    const draft = await compileRequirement(llm, { ...input(SEARCH_TEXT), site });
    expect(draft.criteria.map((c) => c.expectedOutcome)).toEqual([{ kind: "semantic", description: SEARCH_TEXT }]);
    expect(draft.intent?.notes).toHaveLength(3);
    persist(draft);
  });

  it("an answer in the shape before this change compiles as before, with no intent", async () => {
    const { llm } = setup({ json: cartOutput() });
    const draft = await compileRequirement(llm, input(CART_TEXT));
    expect(draft.intent ?? null).toBeNull();
    expect(draft.criteria.every((c) => (c.origin ?? "stated") === "stated")).toBe(true);
  });

  it("wording an inferred criterion made up becomes a visibility check (KI-070 applies to it too)", async () => {
    const out = searchOutput();
    out.criteria[2] = {
      ...out.criteria[2]!,
      expectedOutcome: { kind: "text_matches", fact: { key: "emptyState", checkpoint: "no_results" }, match: { mode: "contains", value: "No products found" } },
    } as never;
    out.facts[2] = { ...out.facts[2]!, valueType: "string" };
    const { llm } = setup({ json: out });
    const draft = await compileRequirement(llm, { ...input(SEARCH_TEXT), site });
    expect(draft.criteria[2]).toMatchObject({ origin: "inferred", expectedOutcome: { kind: "visible", expected: true } });
  });

  it("a vague phrase checked concretely keeps what was assumed; secrets in the model's own words are masked", async () => {
    const out = searchOutput();
    out.criteria[0] = { ...out.criteria[0]!, assumption: "'Test the search' is checked as: hunter2 the search field is shown" } as never;
    out.intent.goal = "A visitor with hunter2 can search";
    const { llm } = setup({ json: out });
    const draft = await compileRequirement(llm, { ...input(SEARCH_TEXT), site, redact: maskValues("hunter2") });
    expect(draft.criteria[0]!.assumption).toBe("'Test the search' is checked as: [REDACTED] the search field is shown");
    expect(draft.intent?.goal).toBe("A visitor with [REDACTED] can search");
  });

  it("the prompt asks for the intent and allows inferred criteria only with pages", async () => {
    const { llm, transport } = setup({ json: searchOutput() });
    await compileRequirement(llm, { ...input(SEARCH_TEXT), site });
    const system = String(transport.requests[0]!.system);
    expect(system).toContain('"intent"');
    expect(system).toContain('"origin":"inferred"');
    expect(system).toMatch(/only when .*pages are provided/i);
  });
});
