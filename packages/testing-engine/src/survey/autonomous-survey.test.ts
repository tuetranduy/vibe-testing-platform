import { RunOptionsSchema, SuggestionSetDraftSchema, type DiscoveryCandidate, type SuggestionSetDraft } from "@platform/contracts";
import { describe, expect, it, vi } from "vitest";
import { DiscoveryPortError, type AutonomousDiscoveryPort } from "../discovery/port";
import type { StageContext } from "../orchestrator/stages";
import { classifyDiscoveryResult, withAutonomousDiscovery } from "./autonomous-survey";

const fixtureUrl = "http://localhost:4178/";
const baseline = SuggestionSetDraftSchema.parse({
  pages: [{ url: fixtureUrl, title: "Fixture", status: "READ" }],
  suggestions: ["Open the catalog", "Use the product filter", "Read the help page"].map((title, index) => ({
    id: `S-${index + 1}`,
    title,
    requirement: `A visitor can ${title.toLowerCase()}.`,
    why: "Found in the site survey.",
    needs: { secrets: [], testData: [] },
    destructive: false,
  })),
});
const candidate = {
  title: "Navigate from category to product",
  goal: "Open a product from the category listing.",
  rationale: "The category and product pages are linked.",
  relevantPaths: ["/catalog", "/products/blue-widget"],
  expectedBehavior: ["The detail page has the selected product title."],
  negativeCases: ["An empty category has an empty-state message."],
} satisfies DiscoveryCandidate;

function context(signal = new AbortController().signal): StageContext {
  return {
    runId: "run_fixture",
    tenantId: "t_default",
    request: {
      targetUrl: fixtureUrl, environment: "staging", requirement: "", browser: "chromium",
      testData: {}, secretNames: [], options: RunOptionsSchema.parse({ autonomousDiscovery: true }),
    },
    deadlineAt: new Date("2026-11-23T00:03:00Z"),
    now: () => new Date("2026-11-23T00:00:00Z"),
    signal,
    budgetSignal: (ms: number) => AbortSignal.any([signal, AbortSignal.timeout(ms)]),
    boundary: async () => signal.throwIfAborted(),
    redact: (value: unknown) => value,
    publish: vi.fn(async () => {}),
    budgets: { explorationMs: 100_000, rerunMs: 30_000 },
    secrets: { names: [], get: () => undefined },
    addCleanup: () => {},
    llm: null,
  };
}

const survey = async (): Promise<SuggestionSetDraft> => baseline;
const completeWith = (candidates: DiscoveryCandidate[]): AutonomousDiscoveryPort["discover"] =>
  async ({ schemaVersion, runId }) => ({ schemaVersion, runId, status: "COMPLETED", candidates });

const published = (ctx: StageContext) => vi.mocked(ctx.publish).mock.calls.map(([event]) => event);
const outcome = (ctx: StageContext) => published(ctx).find((event) => event.type === "discovery.completed" || event.type === "discovery.failed");

describe("fixture discovery in the existing survey", () => {
  it("runs verified live evidence through the offline broker without sending the public URL", async () => {
    const ctx = context();
    ctx.request.environment = "production";
    ctx.request.targetUrl = "https://shop.example.com/catalog";
    ctx.request.options.verifiedSiteDiscovery = true;
    const snapshot = [{ path: "/catalog", title: "Catalog", evidence: "Heading: Products" }];
    const prepareVerifiedSite = vi.fn(async () => ({ draft: baseline, snapshot }));
    const discover = vi.fn(completeWith([{ ...candidate, relevantPaths: ["/catalog"] }]));
    const standard = vi.fn(survey);
    const result = await withAutonomousDiscovery(standard, {
      fixtureUrl, prepareVerifiedSite, port: { discover }, allowsTenant: () => false, reserve: async () => true,
    })(ctx);
    expect(standard).not.toHaveBeenCalled();
    expect(prepareVerifiedSite).toHaveBeenCalledWith(ctx);
    expect(discover).toHaveBeenCalledWith(expect.objectContaining({ targetUrl: fixtureUrl, snapshot }), expect.any(Object));
    expect(result.suggestions.some((suggestion) => suggestion.discovery?.relevantPaths.includes("/catalog"))).toBe(true);
  });
  it("lets the agent interact with the live site itself when the run asks and the broker offers it", async () => {
    const run = async (liveInteraction: boolean) => {
      const ctx = context();
      ctx.request.environment = "production";
      ctx.request.targetUrl = "https://shop.example.com/catalog";
      ctx.request.options.verifiedSiteDiscovery = true;
      ctx.request.options.discoveryLiveInteraction = true;
      const snapshot = [{ path: "/catalog", title: "Catalog", evidence: "Heading: Products" }];
      const discover = vi.fn(completeWith([{ ...candidate, relevantPaths: ["/catalog"] }]));
      await withAutonomousDiscovery(survey, {
        fixtureUrl, prepareVerifiedSite: async () => ({ draft: baseline, snapshot }), port: { discover }, reserve: async () => true,
        ...(liveInteraction && { liveInteraction: true }),
      })(ctx);
      return discover.mock.calls[0]![0];
    };
    const live = await run(true);
    expect(live).toMatchObject({ targetUrl: "https://shop.example.com/catalog", live: true });
    expect(live).not.toHaveProperty("snapshot");
    // A worker whose broker cannot interact uses the offline snapshot instead.
    expect(await run(false)).toMatchObject({ targetUrl: fixtureUrl, snapshot: [{ path: "/catalog" }] });
  });
  it("leaves a run that did not opt in untouched: same suggestions, no discovery events, no adapter call", async () => {
    const ctx = context();
    delete ctx.request.options.autonomousDiscovery;
    const discover = vi.fn(completeWith([candidate]));
    const observe = vi.fn();
    await expect(withAutonomousDiscovery(survey, { fixtureUrl, port: { discover }, observe })(ctx)).resolves.toBe(baseline);
    await expect(withAutonomousDiscovery(survey)(ctx)).resolves.toBe(baseline);
    expect(discover).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
    expect(ctx.publish).not.toHaveBeenCalled();
  });

  it("merges useful candidates in depth order, deduplicates, and preserves two original suggestions", async () => {
    const extras = Array.from({ length: 7 }, (_, index) => ({
      ...candidate, title: `Inspect detail ${index}`, goal: `Check the product detail variant ${index}.`, relevantPaths: ["/catalog"],
    }));
    const discover = vi.fn(completeWith([
      { ...candidate, title: "OPEN THE CATALOG!" },
      ...extras,
      { ...candidate, expectedBehavior: [...candidate.expectedBehavior, "The category listing can be sorted."] },
      { ...candidate, title: "Delete account", goal: "Delete the customer account." },
    ]));
    const ctx = context();
    const observe = vi.fn();
    const result = await withAutonomousDiscovery(survey, { fixtureUrl, port: { discover }, observe })(ctx);
    // The deadline leaves 175 s; the 120 s default stage budget gives the broker 115 s for its whole job.
    expect(discover).toHaveBeenCalledWith({
      schemaVersion: "discovery.v1", runId: "run_fixture", targetUrl: fixtureUrl, timeoutSeconds: 115,
    }, { signal: expect.any(AbortSignal), onProgress: expect.any(Function) });
    expect(result.pages).toBe(baseline.pages);
    expect(result.suggestions.slice(0, 2)).toEqual(baseline.suggestions.slice(0, 2));
    expect(result.suggestions[2]).toMatchObject({ title: candidate.title, why: candidate.rationale, destructive: false });
    expect(result.suggestions[2]?.discovery).toEqual({ engine: "browser_use", relevantPaths: candidate.relevantPaths });
    expect(ctx.publish).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "discovery.completed",
      payload: expect.objectContaining({ status: "COMPLETED", reason: "ok", attempted: true, acceptedCount: 6, fallbackUsed: false }),
    }));
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ status: "COMPLETED" }), expect.any(Number));
    expect(result.suggestions[2]?.requirement).toBe(`${candidate.goal}\nExpected behavior\n${candidate.expectedBehavior[0]}`);
    expect(result.suggestions).toHaveLength(8);
    expect(result.suggestions.map(({ title }) => title)).not.toContain("Delete account");
    expect(SuggestionSetDraftSchema.parse(result)).toEqual(result);
  });

  it.each([
    [{ environment: "production" }, "environment"],
    [{ targetUrl: fixtureUrl + "?token=private" }, "fixture_mismatch"],
    [{ targetUrl: fixtureUrl + "another-fixture" }, "fixture_mismatch"],
  ] as const)("records a typed fallback for an opted-in run outside the disposable fixture (%j)", async (request, reason) => {
    const ctx = context();
    Object.assign(ctx.request, request);
    const discover = vi.fn(completeWith([candidate]));
    const observe = vi.fn();
    await expect(withAutonomousDiscovery(survey, { fixtureUrl, port: { discover }, observe })(ctx)).resolves.toBe(baseline);
    expect(discover).not.toHaveBeenCalled();
    expect(outcome(ctx)).toMatchObject({ type: "discovery.failed", payload: { status: "BLOCKED", reason, attempted: false, fallbackUsed: true } });
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ status: "BLOCKED", reason }), null);
  });

  it("records BLOCKED / not_configured when the API admitted the run but this worker has no discovery transport", async () => {
    for (const deps of [undefined, { observe: vi.fn() }]) {
      const ctx = context();
      await expect(withAutonomousDiscovery(survey, deps)(ctx)).resolves.toBe(baseline);
      expect(published(ctx).map(({ type }) => type)).toEqual(["discovery.failed"]);
      expect(outcome(ctx)?.payload).toMatchObject({ status: "BLOCKED", reason: "not_configured", attempted: false });
      if (deps) expect(deps.observe).toHaveBeenCalledWith(expect.objectContaining({ reason: "not_configured" }), null);
    }
  });

  it("records tenant rollback and an exhausted tenant quota without starting a job", async () => {
    const discover = vi.fn(completeWith([candidate]));
    const disabled = context();
    await withAutonomousDiscovery(survey, { fixtureUrl, port: { discover }, allowsTenant: async () => false })(disabled);
    expect(outcome(disabled)?.payload).toMatchObject({ status: "BLOCKED", reason: "tenant_disabled", attempted: false });
    const quota = context();
    const reserve = vi.fn(async () => false);
    await withAutonomousDiscovery(survey, { fixtureUrl, port: { discover }, reserve })(quota);
    expect(reserve).toHaveBeenCalledWith("t_default");
    expect(outcome(quota)?.payload).toMatchObject({ status: "BUSY", reason: "tenant_quota", attempted: false });
    expect(published(quota).some(({ type }) => type === "discovery.started")).toBe(false);
    expect(discover).not.toHaveBeenCalled();
  });

  it("aborts in-flight discovery when the tenant disables it and keeps the standard survey", async () => {
    const ctx = context();
    let jobSignal: AbortSignal | undefined;
    let enabled = true;
    const discover: AutonomousDiscoveryPort["discover"] = async (_input, { signal }) => {
      jobSignal = signal;
      enabled = false;
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    };
    await expect(withAutonomousDiscovery(survey, { fixtureUrl, port: { discover }, allowsTenant: () => enabled })(ctx)).resolves.toBe(baseline);
    expect(jobSignal?.aborted).toBe(true);
    expect(ctx.signal.aborted).toBe(false);
    expect(published(ctx).map(({ type }) => type)).toEqual(["discovery.started", "discovery.failed"]);
    expect(outcome(ctx)?.payload).toMatchObject({ status: "CANCELLED", reason: "tenant_disabled", attempted: true, acceptedCount: 0 });
  });

  it("discards candidates if the rollout was disabled before a result could be offered", async () => {
    const ctx = context();
    const allowsTenant = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    const discover = completeWith([candidate]);
    await expect(withAutonomousDiscovery(survey, { fixtureUrl, port: { discover }, allowsTenant })(ctx)).resolves.toBe(baseline);
    expect(allowsTenant).toHaveBeenCalledTimes(2);
    expect(outcome(ctx)?.payload).toMatchObject({ status: "CANCELLED", reason: "tenant_disabled", fallbackUsed: true });
  });

  it.each([
    [new DiscoveryPortError("busy", "broker full"), { status: "BUSY", reason: "broker_busy", attempted: false }],
    [new DiscoveryPortError("invalid_result", "bad"), { status: "FAILED", reason: "invalid_result", attempted: true }],
    [new DiscoveryPortError("unavailable", "down"), { status: "FAILED", reason: "broker_unavailable", attempted: true }],
    [new Error("socket hang up"), { status: "FAILED", reason: "broker_unavailable", attempted: true }],
  ] as const)("classifies an adapter failure (%s) and keeps the original suggestions", async (error, expected) => {
    const ctx = context();
    const observe = vi.fn();
    const discover = async () => { throw error; };
    await expect(withAutonomousDiscovery(survey, { fixtureUrl, port: { discover }, observe })(ctx)).resolves.toBe(baseline);
    expect(outcome(ctx)?.payload).toMatchObject({ ...expected, fallbackUsed: true });
    expect(observe).toHaveBeenCalledWith(expect.anything(), expected.attempted ? expect.any(Number) : null);
  });

  it.each([
    [{ status: "PARTIAL", reason: "timeout" }, "TIMED_OUT", "timeout"],
    [{ status: "FAILED", reason: "hard_deadline" }, "TIMED_OUT", "hard_deadline"],
    [{ status: "PARTIAL", reason: "no_valid_candidates" }, "PARTIAL", "no_valid_candidates"],
    [{ status: "PARTIAL" }, "PARTIAL", "no_result"],
    [{ status: "CANCELLED", reason: "cancelled" }, "CANCELLED", "cancelled"],
  ] as const)("classifies the broker's reply %j", async (reply, status, reason) => {
    const ctx = context();
    const discover: AutonomousDiscoveryPort["discover"] = async ({ schemaVersion, runId }) => ({ schemaVersion, runId, candidates: [], ...reply });
    await expect(withAutonomousDiscovery(survey, { fixtureUrl, port: { discover } })(ctx)).resolves.toBe(baseline);
    expect(outcome(ctx)).toMatchObject({ type: "discovery.failed", payload: { status, reason, attempted: true, fallbackUsed: true } });
    expect(classifyDiscoveryResult({ schemaVersion: "discovery.v1", runId: "r", candidates: [], ...reply })).toEqual({ status, reason });
  });

  it("bounds the whole job inside the stage budget and classifies the stage's own deadline as TIMED_OUT", async () => {
    const ctx = context();
    ctx.deadlineAt = new Date("2026-11-23T00:00:25Z");
    const discoveryTimeout = AbortSignal.abort(new DOMException("Discovery timed out", "TimeoutError"));
    ctx.budgetSignal = vi.fn(() => discoveryTimeout);
    const discover = vi.fn(completeWith([candidate]));
    await expect(withAutonomousDiscovery(survey, { fixtureUrl, port: { discover } })(ctx)).resolves.toBe(baseline);
    // 25 s left − 5 s to save the suggestions = a 20 s stage; the broker's job budget ends 5 s before it.
    expect(ctx.budgetSignal).toHaveBeenCalledWith(20_000);
    expect(discover.mock.calls[0]?.[0].timeoutSeconds).toBe(15);
    expect(outcome(ctx)?.payload).toMatchObject({ status: "TIMED_OUT", reason: "worker_deadline", attempted: true });
  });

  it("uses the run's lower discovery budget and steps", async () => {
    const ctx = context();
    ctx.request.options.discoveryMaxSeconds = 30;
    ctx.request.options.discoveryMaxSteps = 6;
    const discover = vi.fn(completeWith([candidate]));
    await withAutonomousDiscovery(survey, { fixtureUrl, port: { discover } })(ctx);
    expect(discover.mock.calls[0]?.[0]).toMatchObject({ timeoutSeconds: 25, maxAgentSteps: 6 });
  });

  it("does not start a job without enough survey time left", async () => {
    const ctx = context();
    ctx.deadlineAt = new Date("2026-11-23T00:00:06Z");
    const discover = vi.fn(completeWith([candidate]));
    await expect(withAutonomousDiscovery(survey, { fixtureUrl, port: { discover } })(ctx)).resolves.toBe(baseline);
    expect(discover).not.toHaveBeenCalled();
    expect(outcome(ctx)?.payload).toMatchObject({ status: "TIMED_OUT", reason: "no_budget", attempted: false });
  });

  it("propagates an actual run cancellation", async () => {
    const controller = new AbortController();
    const error = new Error("run cancelled");
    const discover = async () => {
      controller.abort(error);
      throw new Error("launcher terminated");
    };
    await expect(withAutonomousDiscovery(survey, { fixtureUrl, port: { discover } })(context(controller.signal))).rejects.toBe(error);
  });

  describe("fair admission to the broker's slots", () => {
    it("waits its turn within the discovery budget, then runs with the remaining time and releases the slot", async () => {
      const ctx = context();
      const release = vi.fn(async () => {});
      const admit = vi.fn(async () => ({ granted: true as const, waitedMs: 20_000, release }));
      const discover = vi.fn(completeWith([candidate]));
      await withAutonomousDiscovery(survey, { fixtureUrl, port: { discover }, admit })(ctx);
      // 120 s stage budget: wait up to 115 - 10 s; the lease outlives the job's budget by a grace period.
      expect(admit).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t_default", runId: "run_fixture", maxWaitMs: 105_000, leaseMs: 145_000 }));
      // 20 s spent waiting: the broker's job budget shrinks to 95 s.
      expect(discover.mock.calls[0]?.[0].timeoutSeconds).toBe(95);
      expect(release).toHaveBeenCalledTimes(1);
      expect(outcome(ctx)?.payload).toMatchObject({ status: "COMPLETED" });
    });

    it.each([
      ["not admitted in time", async () => ({ granted: false as const, waitedMs: 105_000 })],
      ["the scheduler is unavailable", async () => { throw new Error("redis down"); }],
    ])("records BUSY / capacity_wait without a job and refunds the quota when %s", async (_case, admit) => {
      const ctx = context();
      const refund = vi.fn();
      const discover = vi.fn(completeWith([candidate]));
      await expect(withAutonomousDiscovery(survey, { fixtureUrl, port: { discover }, admit, refund, reserve: async () => true })(ctx))
        .resolves.toBe(baseline);
      expect(discover).not.toHaveBeenCalled();
      expect(refund).toHaveBeenCalledWith("t_default");
      expect(outcome(ctx)?.payload).toMatchObject({ status: "BUSY", reason: "capacity_wait", attempted: false });
    });

    it("rechecks the rollout after waiting: a disabled tenant gets no job and frees its slot", async () => {
      const ctx = context();
      let enabled = true;
      const release = vi.fn(async () => {});
      const refund = vi.fn();
      const admit = vi.fn(async () => { enabled = false; return { granted: true as const, waitedMs: 1_000, release }; });
      const discover = vi.fn(completeWith([candidate]));
      await withAutonomousDiscovery(survey, { fixtureUrl, port: { discover }, admit, refund, allowsTenant: () => enabled })(ctx);
      expect(discover).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalled();
      expect(refund).toHaveBeenCalled();
      expect(outcome(ctx)?.payload).toMatchObject({ status: "BLOCKED", reason: "tenant_disabled", attempted: false });
    });

    it("ends without a job when the wait used up the budget", async () => {
      const ctx = context();
      const release = vi.fn(async () => {});
      const admit = vi.fn(async () => ({ granted: true as const, waitedMs: 106_000, release }));
      const discover = vi.fn(completeWith([candidate]));
      await withAutonomousDiscovery(survey, { fixtureUrl, port: { discover }, admit })(ctx);
      expect(discover).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalled();
      expect(outcome(ctx)?.payload).toMatchObject({ status: "TIMED_OUT", reason: "no_budget", attempted: false });
    });

    it("propagates a run cancellation while waiting", async () => {
      const controller = new AbortController();
      const error = new Error("run cancelled");
      const admit = vi.fn(async () => { controller.abort(error); throw error; });
      const discover = vi.fn(completeWith([candidate]));
      await expect(withAutonomousDiscovery(survey, { fixtureUrl, port: { discover }, admit })(context(controller.signal))).rejects.toBe(error);
      expect(discover).not.toHaveBeenCalled();
    });
  });
});


describe("exploratory findings from a completed job (Phase C)", () => {
  const found = {
    title: "Help link opens a missing page", observation: "The footer Help link opened a page that says Not Found.",
    expected: "The help page opens", path: "/help", reproduction: ["Click Help in the footer"], severity: "medium" as const,
  };
  it("stores them apart from the suggestions and counts them in the outcome", async () => {
    const ctx = context();
    const recordFindings = vi.fn(async () => 1);
    const discover: AutonomousDiscoveryPort["discover"] = async ({ schemaVersion, runId }) =>
      ({ schemaVersion, runId, status: "COMPLETED", candidates: [candidate], findings: [found] });
    const draft = await withAutonomousDiscovery(survey, { fixtureUrl, port: { discover }, recordFindings })(ctx);
    expect(recordFindings).toHaveBeenCalledWith(ctx, [found]);
    expect(draft.suggestions.some((s) => s.title === found.title)).toBe(false);
    expect(outcome(ctx)).toMatchObject({ type: "discovery.completed", payload: { status: "COMPLETED", findingCount: 1 } });
  });

  it("a storage failure never changes the discovery outcome", async () => {
    const ctx = context();
    const discover: AutonomousDiscoveryPort["discover"] = async ({ schemaVersion, runId }) =>
      ({ schemaVersion, runId, status: "COMPLETED", candidates: [candidate], findings: [found] });
    const logger = { warn: vi.fn() };
    await withAutonomousDiscovery(survey, { fixtureUrl, port: { discover }, logger, recordFindings: async () => { throw new Error("db down"); } })(ctx);
    expect(outcome(ctx)).toMatchObject({ type: "discovery.completed", payload: { status: "COMPLETED" } });
    expect(outcome(ctx)?.payload).not.toHaveProperty("findingCount");
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ runId: "run_fixture" }), "Browser Use findings could not be stored");
  });
});

describe("multi-agent exploration (Phase C)", () => {
  const twoPages = SuggestionSetDraftSchema.parse({
    ...baseline,
    pages: [{ url: fixtureUrl, title: "Fixture", status: "READ" }, { url: `${fixtureUrl}catalog`, title: "Catalog", status: "READ" }],
  });
  const admitAll = (granted: boolean) => vi.fn(async () => (granted
    ? { granted: true as const, waitedMs: 0, release: async () => {} } : { granted: false as const, waitedMs: 0 }));

  it("runs one more agent per free slot, focused on another page, and merges what they found", async () => {
    const ctx = context();
    ctx.request.options.discoveryAgents = 2;
    const second = { ...candidate, title: "Filter the catalog", goal: "Filter the catalog by colour and see fewer products." };
    const discover = vi.fn<AutonomousDiscoveryPort["discover"]>(async ({ schemaVersion, runId }) => ({
      schemaVersion, runId, status: "COMPLETED", candidates: [runId.endsWith("-a2") ? second : candidate],
      statistics: { agentSteps: 4, modelRequests: 4, durationMs: 1000, inputTokens: 10, outputTokens: 5, modelCostUsd: 0.01 },
    }));
    const admit = admitAll(true);
    const reserve = vi.fn(async () => true);
    const draft = await withAutonomousDiscovery(async () => twoPages, { fixtureUrl, port: { discover }, admit, reserve })(ctx);
    expect(discover.mock.calls.map(([input]) => input.runId)).toEqual(["run_fixture", "run_fixture-a2"]);
    expect(discover.mock.calls[1]![0].focus).toContain('"Catalog" page (/catalog)');
    expect(reserve).toHaveBeenCalledTimes(2);
    expect(draft.suggestions.map((s) => s.title)).toEqual(expect.arrayContaining([candidate.title, second.title]));
    expect(outcome(ctx)?.payload).toMatchObject({ status: "COMPLETED", agents: 2, candidateCount: 2,
      statistics: { agentSteps: 8, modelRequests: 8, modelCostUsd: 0.02 } });
  });

  it("starts no extra agent without a free slot, and refunds its quota attempt", async () => {
    const ctx = context();
    ctx.request.options.discoveryAgents = 3;
    const discover = vi.fn(completeWith([candidate]));
    let calls = 0;
    const admit = vi.fn(async () => (calls++ === 0
      ? { granted: true as const, waitedMs: 0, release: async () => {} } : { granted: false as const, waitedMs: 0 }));
    const refund = vi.fn();
    await withAutonomousDiscovery(async () => twoPages, { fixtureUrl, port: { discover }, admit, reserve: async () => true, refund })(ctx);
    expect(discover).toHaveBeenCalledTimes(1);
    expect(refund).toHaveBeenCalledTimes(1);
    expect(outcome(ctx)?.payload).not.toHaveProperty("agents");
  });

  it("keeps a completed extra agent's ideas when the first agent fails", async () => {
    const ctx = context();
    ctx.request.options.discoveryAgents = 2;
    const discover = vi.fn<AutonomousDiscoveryPort["discover"]>(async ({ schemaVersion, runId }) => {
      if (!runId.endsWith("-a2")) throw new DiscoveryPortError("unavailable", "down");
      return { schemaVersion, runId, status: "COMPLETED", candidates: [candidate] };
    });
    const draft = await withAutonomousDiscovery(async () => twoPages, { fixtureUrl, port: { discover }, admit: admitAll(true), reserve: async () => true })(ctx);
    expect(draft.suggestions.some((s) => s.discovery)).toBe(true);
    expect(outcome(ctx)?.payload).toMatchObject({ status: "COMPLETED", agents: 2 });
  });
});

describe("the run's own model (Settings, like Stagehand)", () => {
  it("hands the broker the run's model and key, and blocks without a job when the run has no key", async () => {
    const ctx = context();
    const discover = vi.fn(completeWith([candidate]));
    const model = { provider: "anthropic" as const, model: "claude-sonnet-5-5", apiKey: "sk-ant-settings-123" };
    await withAutonomousDiscovery(survey, { fixtureUrl, port: { discover }, modelFor: async () => model })(ctx);
    expect(discover.mock.calls[0]![0]).toMatchObject({ model });
    // Nothing the run publishes carries the key.
    expect(JSON.stringify(published(ctx))).not.toContain("sk-ant-settings-123");

    const noKey = context();
    const blocked = vi.fn(completeWith([candidate]));
    await withAutonomousDiscovery(survey, { fixtureUrl, port: { discover: blocked }, modelFor: async () => { throw new Error("No API key") } })(noKey);
    expect(blocked).not.toHaveBeenCalled();
    expect(outcome(noKey)).toMatchObject({ type: "discovery.failed", payload: { status: "BLOCKED", reason: "model_not_configured", attempted: false } });
  });
});
