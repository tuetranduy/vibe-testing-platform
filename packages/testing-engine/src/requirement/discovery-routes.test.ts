import { NormalizedRequirementSchema, RunOptionsSchema, type DiscoveryCandidate, type StoredTestRunRequest } from "@platform/contracts";
import { FakeTransport, LlmClient } from "@platform/llm";
import { createRunRedactor } from "@platform/security";
import { describe, expect, it, vi } from "vitest";
import type { AutonomousDiscoveryPort } from "../discovery/port";
import type { AutonomousSurveyDeps } from "../discovery/run-job";
import type { EventDraft, StageContext } from "../orchestrator/stages";
import { createAnalyzeStage } from "./compiler";
import { discoveryFocus, routesForRequirement } from "./discovery-routes";

const FIXTURE = "http://127.0.0.1:4599/";
const TEXT = "Add a product to the cart and check that the cart lists it.";

const candidate = (title: string, goal: string, paths: string[], extra: Partial<DiscoveryCandidate> = {}): DiscoveryCandidate => ({
  title, goal, rationale: "Observed on the fixture.", relevantPaths: paths, expectedBehavior: ["The cart lists the product."], negativeCases: [], ...extra,
});
const CART = candidate("Add tea to the cart", "Open the Assam tea page and add it to the cart.", ["/product-assam.html", "/cart.html"]);
const SEARCH = candidate("Search the catalog", "Search for green and open the first result.", ["/search.html"], { expectedBehavior: ["Results list green teas."] });
const DELETE = candidate("Empty the cart", "Delete every product in the cart page.", ["/cart.html"]);

describe("Browser Use routes for a written requirement (Phase B)", () => {
  it("keeps only read-only candidates related to the requirement, most relevant first, at most four", () => {
    const routes = routesForRequirement([SEARCH, DELETE, CART, ...Array.from({ length: 6 }, (_, i) =>
      candidate(`Cart variant ${i}`, `Add product ${i} to the cart from the listing page.`, ["/cart.html"]))], TEXT);
    expect(routes).toHaveLength(4);
    expect(routes[0]!.title).toBe("Add tea to the cart");
    expect(routes.map((r) => r.title)).not.toContain("Search the catalog");
    expect(routes.map((r) => r.title)).not.toContain("Empty the cart");
    expect(routesForRequirement([CART, { ...CART, title: "Same goal again" }], TEXT)).toHaveLength(1);
    expect(routesForRequirement([SEARCH], TEXT)).toEqual([]);
  });

  it("gives the agent the redacted requirement on one line", () => {
    const redact = createRunRedactor();
    expect(discoveryFocus({ redact, request: { requirement: "Add a product\n\tto the cart" } as StoredTestRunRequest })).toBe("Add a product to the cart");
    expect(discoveryFocus({ redact, request: { requirement: "short" } as StoredTestRunRequest })).toBeUndefined();
  });

  it("keeps later checkpoints in a long written workflow", () => {
    const requirement = `When User opens the Vehicle page\n${"And User enters vehicle information\n".repeat(35)}Then Rider Summary Page is displayed`;
    const focus = discoveryFocus({ redact: (value) => value, request: { requirement } as StoredTestRunRequest });
    expect(focus).toContain("When User opens the Vehicle page");
    expect(focus).toContain("Then Rider Summary Page is displayed");
    expect(focus!.length).toBeLessThanOrEqual(1000);
  });
});

const compiled = {
  title: "Add to cart",
  intent: { clarity: "specific", goal: "A visitor can add a product to the cart", feature: "Cart" },
  criteria: [
    {
      sourceText: "check that the cart lists it",
      statement: "The cart lists the product",
      expectedOutcome: { kind: "visible", fact: { key: "listed", checkpoint: "cart_page" }, expected: true },
      preconditions: [], ambiguity: null,
    },
    {
      sourceText: TEXT, statement: "The product page shows an Add to cart button",
      expectedOutcome: { kind: "visible", fact: { key: "addButton", checkpoint: "product_page" }, expected: true },
      preconditions: [], ambiguity: null, origin: "inferred", rationale: "Browser Use saw the button on the product page.", discoveryRoute: 1,
    },
    {
      sourceText: TEXT, statement: "A route number the prompt never listed",
      expectedOutcome: { kind: "visible", fact: { key: "other", checkpoint: "product_page" }, expected: true },
      preconditions: [], ambiguity: null, origin: "inferred", rationale: "Made up.", discoveryRoute: 7,
    },
  ],
  facts: [
    { key: "listed", checkpoint: "cart_page", description: "The product is in the cart", valueType: "boolean" },
    { key: "addButton", checkpoint: "product_page", description: "Add to cart button", valueType: "boolean" },
    { key: "other", checkpoint: "product_page", description: "Other", valueType: "boolean" },
  ],
  siteChecks: [], testData: [],
};

function setup(port: AutonomousDiscoveryPort["discover"], deps: Partial<AutonomousSurveyDeps> = {}) {
  const transport = new FakeTransport().enqueue({ json: compiled });
  const events: EventDraft[] = [];
  const signal = new AbortController().signal;
  const ctx: StageContext = {
    runId: "run_1", tenantId: "t_1",
    request: {
      targetUrl: FIXTURE, requirement: TEXT, environment: "staging", browser: "chromium", testData: {}, secretNames: [],
      options: RunOptionsSchema.parse({ autonomousDiscovery: true, analyzeLiveSite: false }),
    },
    signal, deadlineAt: null, budgets: { explorationMs: 60_000, rerunMs: 1000 },
    secrets: { names: [], get: () => undefined }, redact: createRunRedactor(),
    publish: async (e) => void events.push(e), addCleanup: () => {}, boundary: async () => {},
    budgetSignal: (ms) => AbortSignal.any([signal, AbortSignal.timeout(ms)]), now: () => new Date(),
    llm: new LlmClient({ transport, model: "claude-sonnet-5", sleep: async () => {} }),
  };
  const discover = vi.fn(port);
  const discovery: AutonomousSurveyDeps = { fixtureUrl: FIXTURE, port: { discover }, allowsTenant: () => true, ...deps };
  return { ctx, events, transport, discover, stage: createAnalyzeStage({ discovery }) };
}

describe("the analysis of an opted-in written requirement (Phase B)", () => {
  it("asks Browser Use with the requirement as focus, and adds only cited, non-critical checks for review", async () => {
    const h = setup(async ({ schemaVersion, runId }) => ({ schemaVersion, runId, status: "COMPLETED", candidates: [SEARCH, CART] }));
    const result = await h.stage(h.ctx);

    expect(h.discover.mock.calls[0]![0]).toMatchObject({ targetUrl: FIXTURE, focus: TEXT, timeoutSeconds: 235 });
    const prompt = h.transport.requests[0]!.messages[0]!.content as string;
    expect(prompt).toContain("<<<ROUTES");
    expect(prompt).toContain("Add tea to the cart");
    expect(prompt).not.toContain("Search the catalog");

    // The stated check decides; the route's check is reviewed and starts non-critical; the uncited one is dropped.
    expect(result.criteria.map((c) => [c.statement, c.critical, c.discovery?.relevantPaths ?? null])).toEqual([
      ["The cart lists the product", true, null],
      ["The product page shows an Add to cart button", false, ["/product-assam.html", "/cart.html"]],
    ]);
    expect(result.criteria[1]).not.toHaveProperty("discoveryRoute");
    expect(NormalizedRequirementSchema.safeParse({ ...result, runId: "run_1", revision: 1, confirmedAt: null }).success).toBe(true);
    expect(result.siteAnalysis?.discovery).toMatchObject({
      summary: { status: "COMPLETED", acceptedCount: 1, candidateCount: 2 },
      routes: [{ title: "Add tea to the cart" }],
    });
    expect(h.events.map((e) => e.type)).toEqual(["discovery.started", "discovery.completed"]);
  });

  it("analyzes the requirement as before when Browser Use is unavailable", async () => {
    const h = setup(async () => { throw new Error("connection refused"); });
    const result = await h.stage(h.ctx);
    const prompt = h.transport.requests[0]!.messages[0]!.content as string;
    expect(prompt).not.toContain("<<<ROUTES");
    // Without routes, the cited criterion is an ordinary inferred one on a specific requirement: dropped.
    expect(result.criteria.map((c) => c.statement)).toEqual(["The cart lists the product"]);
    expect(result.siteAnalysis?.discovery).toMatchObject({ summary: { status: "FAILED", reason: "broker_unavailable", fallbackUsed: true }, routes: [] });
    expect(h.events.find((e) => e.type === "discovery.failed")?.message).toBe("Browser Use was unavailable. Analyzing the requirement without it.");
  });

  it("records a rolled-back tenant without starting a job", async () => {
    const h = setup(async () => { throw new Error("unreachable"); }, { allowsTenant: () => false });
    const result = await h.stage(h.ctx);
    expect(h.discover).not.toHaveBeenCalled();
    expect(result.siteAnalysis?.discovery?.summary).toMatchObject({ status: "BLOCKED", reason: "tenant_disabled", attempted: false });
  });

  it("does not run discovery for a run that did not opt in", async () => {
    const h = setup(async () => { throw new Error("unreachable"); });
    h.ctx.request.options = RunOptionsSchema.parse({ analyzeLiveSite: false });
    const result = await h.stage(h.ctx);
    expect(h.discover).not.toHaveBeenCalled();
    expect(result.siteAnalysis).not.toHaveProperty("discovery");
    expect(h.events).toEqual([]);
  });
});

describe("routes for one step during exploration (Phase C)", () => {
  it("runs a short quiet job under its own id and returns the routes that fit the step", async () => {
    const { discoverStepRoutes } = await import("./discovery-routes");
    const h = setup(async ({ schemaVersion, runId }) => ({ schemaVersion, runId, status: "COMPLETED", candidates: [SEARCH, CART] }));
    const routes = await discoverStepRoutes(h.ctx, { fixtureUrl: FIXTURE, port: { discover: h.discover }, allowsTenant: () => true }, "Click Add to cart for Assam tea");
    expect(routes.map((r) => r.title)).toEqual(["Add tea to the cart"]);
    expect(h.discover.mock.calls[0]![0]).toMatchObject({ runId: "run_1-r1", timeoutSeconds: 85, focus: expect.stringContaining("Add to cart for Assam tea") });
    expect(h.events).toEqual([]);
  });

  it("asks nothing for a run that did not opt in, or a snapshot-only live-site run", async () => {
    const { discoverStepRoutes } = await import("./discovery-routes");
    const h = setup(async () => { throw new Error("unreachable"); });
    h.ctx.request.options = RunOptionsSchema.parse({});
    expect(await discoverStepRoutes(h.ctx, { fixtureUrl: FIXTURE, port: { discover: h.discover } }, "Open the cart")).toEqual([]);
    h.ctx.request.options = RunOptionsSchema.parse({ autonomousDiscovery: true, verifiedSiteDiscovery: true });
    expect(await discoverStepRoutes(h.ctx, { fixtureUrl: FIXTURE, port: { discover: h.discover } }, "Open the cart")).toEqual([]);
    expect(h.discover).not.toHaveBeenCalled();
  });
});
