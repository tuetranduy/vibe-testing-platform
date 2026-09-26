import type { NormalizedRequirement, TestRunSummary } from "@platform/contracts";

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
  requirementPreview: "Add a product to the cart; the cart count goes up and the page feels fast.",
  createdAt: "2026-09-26T10:00:00.000Z",
  startedAt: null,
  finishedAt: null,
  ...patch,
});

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
