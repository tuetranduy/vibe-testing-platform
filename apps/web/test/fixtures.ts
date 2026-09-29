import {
  LlmSettingsViewSchema,
  TestReportSchema,
  type CriterionResult,
  type LlmSettingsView,
  type NormalizedRequirement,
  type TestReport,
  type TestRunSummary,
} from "@platform/contracts";

export const requirementFixture = (): NormalizedRequirement => ({
  runId: "run_1",
  revision: 1,
  originalText: "Add a product to the cart; the cart count goes up and the page feels fast.",
  criteria: [
    {
      id: "AC-1",
      sourceText: "the cart count goes up",
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
    {
      id: "AC-2",
      sourceText: "the cart count goes up",
      statement: "The cart count increases by the right amount",
      expectedOutcome: {
        kind: "numeric_delta",
        before: { key: "cartCount", checkpoint: "before_add" },
        after: { key: "cartCount", checkpoint: "after_add" },
        delta: 1,
      },
      preconditions: [],
      ambiguity: { reason: "Amount not specified", suggestions: ["Increase by exactly 1", "Increase by the quantity chosen"] },
    },
    {
      id: "AC-3",
      sourceText: "the page feels fast",
      statement: "The page feels fast",
      expectedOutcome: { kind: "semantic", description: "The page responds quickly" },
      preconditions: [],
      ambiguity: null,
    },
  ],
  facts: [
    { key: "cartCount", checkpoint: "before_add", description: "Cart badge count", valueType: "number" },
    { key: "cartCount", checkpoint: "after_add", description: "Cart badge count", valueType: "number" },
  ],
  confirmedAt: null,
});

export const summaryFixture = (patch: Partial<TestRunSummary> = {}): TestRunSummary => ({
  runId: "run_1",
  lifecycle: "AWAITING_CONFIRMATION",
  verdict: null,
  errorCategory: null,
  cancelReason: null,
  targetUrl: "https://shop.example.com/",
  environment: "staging",
  allowDestructiveActions: false,
  requirementPreview: "Add a product to the cart; the cart count goes up and the page feels fast.",
  createdAt: "2026-09-26T10:00:00.000Z",
  startedAt: null,
  finishedAt: null,
  llm: null,
  ...patch,
});

/**
 * `GET /v1/settings/llm` with nothing saved: LLM_PROVIDER=anthropic and ANTHROPIC_API_KEY on the server, no
 * Gemini key, the fake engine offered (development).
 */
export const llmSettingsFixture = (patch: Partial<LlmSettingsView> = {}): LlmSettingsView =>
  LlmSettingsViewSchema.parse({
    defaults: { provider: "anthropic", model: "claude-sonnet-5", label: "Claude Sonnet 5", reasoning: "default", source: "environment", available: true },
    providers: [
      { provider: "anthropic", label: "Anthropic", key: { source: "environment", updatedAt: null } },
      { provider: "gemini", label: "Google Gemini", key: { source: null, updatedAt: null } },
    ],
    models: [
      { provider: "anthropic", id: "claude-opus-5-5", label: "Claude Opus 5.5", reasoningLevels: ["default", "low", "medium", "high"], defaultLevel: "medium", price: { inputUsdPerMTok: 4, outputUsdPerMTok: 20 }, available: true },
      { provider: "anthropic", id: "claude-sonnet-5", label: "Claude Sonnet 5", reasoningLevels: ["default", "low", "medium", "high"], defaultLevel: "high", price: { inputUsdPerMTok: 2, outputUsdPerMTok: 10 }, available: true },
      { provider: "anthropic", id: "claude-haiku-4-5", label: "Claude Haiku 4.5", reasoningLevels: ["default"], defaultLevel: null, price: { inputUsdPerMTok: 1, outputUsdPerMTok: 5 }, available: true },
      { provider: "gemini", id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", reasoningLevels: ["default", "low", "medium", "high"], defaultLevel: "medium", price: { inputUsdPerMTok: 0.75, outputUsdPerMTok: 3.75 }, available: false },
      { provider: "gemini", id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite", reasoningLevels: ["default", "minimal", "low", "medium", "high"], defaultLevel: "minimal", price: { inputUsdPerMTok: 0.3, outputUsdPerMTok: 2.5 }, available: false },
      { provider: "fake", id: "fake", label: "Fake engine (development)", reasoningLevels: ["default"], defaultLevel: null, price: null, available: true },
    ],
    ...patch,
  });

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const reportRequirement = (): NormalizedRequirement => ({
  runId: "run_1",
  revision: 1,
  originalText:
    "Search for an iPhone and add it to the cart; the cart count goes up. Log in to see the order history. The page feels fast. The price is shown.",
  criteria: [
    {
      id: "AC-1",
      sourceText: "add it to the cart",
      statement: "The selected product appears in the cart",
      expectedOutcome: {
        kind: "collection_contains",
        collection: { key: "cartItems", checkpoint: "after_add" },
        item: "iPhone",
        match: "contains",
      },
      preconditions: [],
      ambiguity: null,
    },
    {
      id: "AC-2",
      sourceText: "the cart count goes up",
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
    {
      id: "AC-3",
      sourceText: "Log in to see the order history",
      statement: "A logged-in user can see their order history",
      expectedOutcome: { kind: "visible", fact: { key: "orderHistory", checkpoint: "after_login" }, expected: true },
      preconditions: [{ kind: "secret", ref: "password", description: "Account password" }],
      ambiguity: null,
    },
    {
      id: "AC-4",
      sourceText: "The page feels fast",
      statement: "The page feels fast",
      expectedOutcome: { kind: "semantic", description: "The page responds quickly" },
      preconditions: [],
      ambiguity: null,
    },
    {
      id: "AC-5",
      sourceText: "The price is shown",
      statement: "The product price is shown",
      expectedOutcome: { kind: "visible", fact: { key: "price", checkpoint: "after_add" }, expected: true },
      preconditions: [],
      ambiguity: null,
    },
  ],
  facts: [
    { key: "cartItems", checkpoint: "after_add", description: "Items in the cart", valueType: "string_list" },
    { key: "cartCount", checkpoint: "before_add", description: "Cart badge count", valueType: "number" },
    { key: "cartCount", checkpoint: "after_add", description: "Cart badge count", valueType: "number" },
    { key: "orderHistory", checkpoint: "after_login", description: "Order history list", valueType: "boolean" },
    { key: "price", checkpoint: "after_add", description: "Product price", valueType: "boolean" },
  ],
  confirmedAt: "2026-09-26T10:00:30.000Z",
});

type ResultPatch = Partial<CriterionResult> & Pick<CriterionResult, "criterionId" | "status">;
export const resultFixture = (r: ResultPatch): CriterionResult => ({
  reason: null,
  factRefs: [],
  expected: `Expected for ${r.criterionId}`,
  actual: `Actual for ${r.criterionId}`,
  verdictSource: null,
  rerunOutcome: "UNAVAILABLE",
  provisional: { status: r.status, reason: r.reason ?? null },
  evidenceArtifactIds: [],
  relatedStepIds: [],
  aiNote: null,
  ...r,
});

/** A full COMPLETED report: one criterion of every status, plus a discovery/rerun disagreement. */
export const reportFixture = (patch: Partial<TestReport> = {}): TestReport =>
  TestReportSchema.parse({
    runId: "run_1",
    lifecycle: "COMPLETED",
    verdict: "FAILED",
    error: null,
    partial: false,
    targetUrl: "https://shop.example.com/",
    requirement: reportRequirement(),
    summary: { totalCriteria: 5, passed: 1, failed: 1, blocked: 1, inconclusive: 2, confirmedByRerun: 1 },
    criteria: [
      resultFixture({
        criterionId: "AC-1",
        status: "PASS",
        verdictSource: "PLAYWRIGHT_RERUN",
        rerunOutcome: "PASSED",
        expected: "Cart items contain “iPhone”",
        actual: "Cart items: iPhone 15 Pro",
        evidenceArtifactIds: ["art_1"],
        relatedStepIds: ["st_1", "st_2"],
      }),
      resultFixture({
        criterionId: "AC-2",
        status: "FAIL",
        verdictSource: "EXPLORATION_ONLY",
        rerunOutcome: "NOT_REACHED",
        expected: "Cart count after adding is greater than before adding",
        actual: "Cart count stayed at 0",
      }),
      resultFixture({ criterionId: "AC-3", status: "BLOCKED", reason: "MISSING_SECRET", actual: null }),
      resultFixture({
        criterionId: "AC-4",
        status: "INCONCLUSIVE",
        reason: "AI_JUDGED_ONLY",
        actual: null,
        aiNote: "The page appeared to respond within about a second.",
      }),
      resultFixture({
        criterionId: "AC-5",
        status: "INCONCLUSIVE",
        reason: "DISCOVERY_RERUN_DISAGREE",
        rerunOutcome: "ASSERTION_FAILED",
        provisional: { status: "PASS", reason: null },
      }),
    ],
    generatedTest: {
      id: "gt_1",
      source: 'import { test, expect } from "@playwright/test";\n\ntest("cart", async ({ page }) => {\n  await page.goto(data.targetUrl);\n});\n',
      compiledCriteria: ["AC-1", "AC-2", "AC-5"],
      notCompiled: [
        { criterionId: "AC-3", reason: "Blocked before exploration" },
        { criterionId: "AC-4", reason: "Semantic criteria cannot be asserted" },
      ],
      notes: ["Step 3 uses a CSS locator; it may break if the page layout changes"],
    },
    playwright: { status: "FAILED", durationMs: 8200 },
    diagnostics: [
      { criterionId: "AC-2", summary: "The add-to-cart button click did not update the cart badge." },
      { criterionId: null, summary: "The site loaded slowly on the first visit." },
    ],
    usage: { llmCalls: 12, inputTokens: 30500, outputTokens: 4200, estimatedCostUsd: 0.0421 },
    startedAt: "2026-09-26T10:00:30.000Z",
    finishedAt: "2026-09-26T10:02:05.000Z",
    durationMs: 95000,
    ...patch,
  });
