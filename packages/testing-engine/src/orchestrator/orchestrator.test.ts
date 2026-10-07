import {
  CancelledError,
  ContractError,
  SuggestionSetSchema,
  type ExplorationStep,
  type GeneratedTest,
  type NormalizedRequirement,
  type ProvisionalResult,
  type RunLifecycle,
  type SiteAnalysisDraft,
  type StoredTestRunRequest,
  type SuggestionSet,
} from "@platform/contracts";
import { describe, expect, it } from "vitest";
import { createFakeStages, fakeSuggestionSet } from "./fake-stages";
import { runAnalysis, runExecution, runRerunOnly, runSurvey, type RunPorts, type TransitionPatch } from "./orchestrator";
import type { EventDraft, ReportInput, StageContext } from "./stages";

const request = (requirement: string, patch: Partial<StoredTestRunRequest["options"]> = {}): StoredTestRunRequest => ({
  targetUrl: "https://shop.example.com/",
  requirement,
  environment: "staging",
  browser: "chromium",
  testData: {},
  secretNames: [],
  options: {
    maxExplorationSteps: 40,
    maxRunSeconds: 300,
    generatePlaywright: true,
    rerunGeneratedTest: true,
    autoConfirmCriteria: false,
    allowDestructiveActions: false,
    additionalAllowedHosts: [],
    ...patch,
  },
});

function context(req: StoredTestRunRequest, opts: { cancelAfterStage?: () => boolean } = {}): StageContext {
  const ac = new AbortController();
  return {
    runId: "run_1",
    tenantId: "t_default",
    request: req,
    signal: ac.signal,
    deadlineAt: null,
    budgets: { explorationMs: 1000, rerunMs: 1000 },
    secrets: { names: [], get: () => undefined },
    redact: (v) => v,
    publish: async () => {},
    addCleanup: () => {},
    boundary: async () => {
      if (opts.cancelAfterStage?.()) throw new CancelledError();
    },
    budgetSignal: () => ac.signal,
    now: () => new Date(),
    llm: null, // the fake engine's runs have no model client
  };
}

function ports(start: RunLifecycle) {
  const events: EventDraft[] = [];
  const transitions: [RunLifecycle, TransitionPatch | undefined][] = [];
  let lifecycle = start;
  let saved: SuggestionSet | null = null;
  let requirement: NormalizedRequirement | null = null;
  const siteAnalyses: SiteAnalysisDraft[] = [];
  const applied: Record<string, unknown>[] = [];
  const p: RunPorts = {
    lifecycle: () => lifecycle,
    transition: async (to, patch) => {
      transitions.push([to, patch]);
      lifecycle = to;
    },
    publish: async (e) => void events.push(e),
    saveRequirement: async (draft) => (requirement = { ...draft, runId: "run_1", revision: 1, confirmedAt: null }),
    confirmRequirement: async () => ({ ...requirement!, confirmedAt: new Date().toISOString() }),
    getConfirmedRequirement: async () => requirement!,
    savePlan: async () => {},
    saveResults: async () => {},
    enqueueExecute: async () => {},
    getGeneratedTest: async () => {
      throw new Error("no generated test in this test");
    },
    saveSuggestions: async (draft) => (saved = SuggestionSetSchema.parse({ ...draft, selected: null })),
    saveSiteAnalysis: async (a) => void siteAnalyses.push(a),
    applyTestData: async (values) => void applied.push(values),
    getSiteAnalysis: async () => null,
  };
  return {
    ports: p,
    events,
    transitions,
    saved: () => saved,
    requirement: () => requirement,
    lifecycle: () => lifecycle,
    siteAnalyses,
    applied,
  };
}

describe("runSurvey (a blank requirement)", () => {
  it("QUEUED → SURVEYING → AWAITING_SELECTION: stage events, the pages, the stored suggestions, then no heartbeat", async () => {
    const p = ports("QUEUED");
    const ctx = context(request(""));
    ctx.publish = p.ports.publish; // the fake survey publishes its pages through the context
    await runSurvey(ctx, p.ports, createFakeStages());

    expect(p.transitions.map(([to]) => to)).toEqual(["SURVEYING", "AWAITING_SELECTION"]);
    expect(p.transitions[0]![1]?.heartbeatAt).toBeInstanceOf(Date);
    expect(p.transitions[1]![1]).toEqual({ heartbeatAt: null });
    expect(p.events.map((e) => [e.type, e.message])).toEqual([
      ["stage.started", "Exploring for test ideas started"],
      ["page.surveyed", "Loaded / — Home · Demo Shop"],
      ["page.surveyed", "Loaded /products — Products · Demo Shop"],
      ["suggestions.proposed", "3 tests suggested"],
      ["stage.completed", "Exploring for test ideas completed"],
    ]);
    const saved = p.saved()!;
    expect(saved.selected).toBeNull();
    expect(saved.suggestions.map((s) => s.title)).toEqual(["Add a product to the cart", "Search for a product", "Sign in to the account"]);
    const proposed = p.events.find((e) => e.type === "suggestions.proposed")!;
    expect(proposed.payload).toEqual({ count: 3, suggestions: saved.suggestions.map((s) => ({ id: s.id, title: s.title })) });
    for (const s of saved.suggestions) expect(JSON.stringify(p.events)).not.toContain(s.requirement);
  });

  it("the fake survey: three demo-shop suggestions, the last needing a password; two pages; no browser", () => {
    const set = fakeSuggestionSet("http://demo-shop:4000/");
    expect(set.suggestions.map((s) => s.id)).toEqual(["S-1", "S-2", "S-3"]);
    expect(set.suggestions[2]!.needs.secrets).toEqual(["password"]);
    expect(set.pages.map((p) => [p.url, p.status])).toEqual([
      ["http://demo-shop:4000/", "READ"],
      ["http://demo-shop:4000/products", "READ"],
    ]);
  });

  it("the fake survey waits the configured step delay", async () => {
    const p = ports("QUEUED");
    const started = Date.now();
    await runSurvey(context(request("")), p.ports, createFakeStages({ stepDelayMs: 50 }));
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
  });

  it("a stage error stops before AWAITING_SELECTION, with nothing stored", async () => {
    const p = ports("QUEUED");
    const stages = createFakeStages({ failAt: { stage: "survey", error: new ContractError("no valid suggestion") } });
    await expect(runSurvey(context(request("")), p.ports, stages)).rejects.toBeInstanceOf(ContractError);
    expect(p.lifecycle()).toBe("SURVEYING");
    expect(p.saved()).toBeNull();
  });

  it("a cancel after the survey stage stops before AWAITING_SELECTION", async () => {
    const p = ports("QUEUED");
    let checks = 0;
    // boundary #1 follows stage.started, #2 follows the survey stage.
    await expect(runSurvey(context(request(""), { cancelAfterStage: () => ++checks >= 2 }), p.ports, createFakeStages())).rejects.toBeInstanceOf(
      CancelledError,
    );
    expect(p.lifecycle()).toBe("SURVEYING");
  });
});

describe("runAnalysis after a selection", () => {
  it("starts from ANALYZING_REQUIREMENT (the API moved the run): no transition into it, the chosen text compiled", async () => {
    const chosen = "A user can add iPhone 17 Pro to the cart from its product page, and the cart then lists it.";
    const p = ports("ANALYZING_REQUIREMENT");
    await runAnalysis(context(request(chosen)), p.ports, createFakeStages());
    expect(p.transitions.map(([to]) => to)).toEqual(["AWAITING_CONFIRMATION"]);
    expect(p.events.map((e) => e.type)).toEqual(["stage.started", "criteria.proposed", "stage.completed"]);
    expect(p.requirement()!.originalText).toBe(chosen);
  });

  it("from QUEUED it still moves the run into ANALYZING_REQUIREMENT first", async () => {
    const p = ports("QUEUED");
    await runAnalysis(context(request("A user can add a product to the cart.")), p.ports, createFakeStages());
    expect(p.transitions.map(([to]) => to)).toEqual(["ANALYZING_REQUIREMENT", "AWAITING_CONFIRMATION"]);
  });

  it("the fake engine refuses an empty requirement too", async () => {
    await expect(createFakeStages().analyze(context(request("")))).rejects.toBeInstanceOf(ContractError);
  });
});

describe("runRerunOnly (a manual rerun, V1.1 F5)", () => {
  const requirement: NormalizedRequirement = {
    runId: "run_1",
    revision: 1,
    originalText: "The cart count is 1.",
    criteria: [
      {
        id: "AC-1",
        sourceText: "The cart count is 1.",
        statement: "Cart count is 1",
        expectedOutcome: { kind: "numeric_compare", left: { key: "cartCount", checkpoint: "after_add" }, operator: "eq", right: 1 },
        preconditions: [],
        critical: true,
        ambiguity: null,
      },
    ],
    facts: [{ key: "cartCount", checkpoint: "after_add", description: "Cart count", valueType: "number" }],
    confirmedAt: "2026-09-29T10:00:00.000Z",
  };
  const test: GeneratedTest = { id: "gt_1", source: "", helpersSource: "", dataJson: "{}", compiledCriteria: ["AC-1"], notCompiled: [], notes: [] };

  function rerunPorts() {
    const p = ports("QUEUED");
    const saved: ProvisionalResult[] = [];
    p.ports.getConfirmedRequirement = async () => requirement;
    p.ports.getGeneratedTest = async () => test;
    p.ports.saveResults = async (r) => void saved.push(...r);
    return { ...p, saved };
  }

  it("QUEUED → RUNNING_PLAYWRIGHT → GENERATING_REPORT → COMPLETED; earlier stages skipped; PASS from the rerun alone", async () => {
    const p = rerunPorts();
    let modelCalls = 0;
    const stages = createFakeStages();
    const analyze = stages.analyze;
    stages.analyze = async (ctx) => (modelCalls++, analyze(ctx));
    const verdict = await runRerunOnly(context(request("The cart count is 1.")), p.ports, stages);

    expect(verdict).toBe("PASSED");
    expect(modelCalls).toBe(0);
    expect(p.transitions.map(([to]) => to)).toEqual(["RUNNING_PLAYWRIGHT", "GENERATING_REPORT", "COMPLETED"]);
    const skipped = p.events.filter((e) => e.type === "stage.skipped").map((e) => (e.payload as { stage: string }).stage);
    expect(skipped).toEqual(["ANALYZING_REQUIREMENT", "PLANNING", "EXPLORING", "VERIFYING", "GENERATING_TEST"]);
    expect(p.events.map((e) => e.type)).toContain("playwright.completed");
    expect(p.saved).toMatchObject([{ criterionId: "AC-1", status: "PASS", verdictSource: "PLAYWRIGHT_RERUN" }]);
    expect(p.events.at(-1)).toMatchObject({ type: "run.completed", payload: { verdict: "PASSED" } });
  });

  it("a failing rerun ends COMPLETED / FAILED with a rerun-confirmed FAIL", async () => {
    const p = rerunPorts();
    const verdict = await runRerunOnly(context(request("The cart count is 1.")), p.ports, createFakeStages({ provisionalStatus: "FAIL" }));
    expect(verdict).toBe("FAILED");
    expect(p.saved).toMatchObject([{ status: "FAIL", verdictSource: "PLAYWRIGHT_RERUN", rerunOutcome: "ASSERTION_FAILED" }]);
  });

  it("cancellation before the rerun throws and never reaches COMPLETED", async () => {
    const p = rerunPorts();
    await expect(runRerunOnly(context(request("x".repeat(20)), { cancelAfterStage: () => true }), p.ports, createFakeStages())).rejects.toBeInstanceOf(
      CancelledError,
    );
    expect(p.transitions).toEqual([]);
  });
});

describe("V1.3: the live-site analysis, suggested test data and blocked evidence", () => {
  const siteAnalysis: SiteAnalysisDraft = {
    status: "READ",
    reason: null,
    pages: [{ url: "https://shop.example.com/", title: "Home", status: "READ" }],
    checks: [{ criterionId: "AC-1", status: "FOUND", note: "The home page has a cart" }],
    testData: [{ key: "email", value: "qa.abc123@example.com", description: "Email to register with", source: "GENERATED" }],
  };
  const withAnalysis = () => {
    const stages = createFakeStages();
    const analyze = stages.analyze;
    stages.analyze = async (ctx) => ({ ...(await analyze(ctx)), siteAnalysis });
    return stages;
  };

  it("stores the site analysis before the criteria are announced, apart from the requirement", async () => {
    const p = ports("QUEUED");
    let announcedWith = -1;
    const publish = p.ports.publish;
    p.ports.publish = async (e) => {
      if (e.type === "criteria.proposed") announcedWith = p.siteAnalyses.length;
      await publish(e);
    };
    await runAnalysis(context(request("A user can register with an email address.")), p.ports, withAnalysis());
    expect(p.siteAnalyses).toEqual([siteAnalysis]);
    expect(announcedWith).toBe(1);
    expect(p.requirement()).not.toHaveProperty("siteAnalysis");
    expect(p.applied).toEqual([]); // reviewed criteria: the user decides at confirmation
  });

  it("auto-confirmed criteria take the suggested test data as suggested", async () => {
    const p = ports("QUEUED");
    await runAnalysis(context(request("A user can register with an email address.", { autoConfirmCriteria: true })), p.ports, withAnalysis());
    expect(p.applied).toEqual([{ email: "qa.abc123@example.com" }]);
    expect(p.transitions.map(([to]) => to)).toEqual(["ANALYZING_REQUIREMENT", "PLANNING"]);
  });

  it("execution first takes every suggested value the run still lacks, a manually confirmed run's too (2026-10-07)", async () => {
    const p = ports("PLANNING");
    p.ports.getConfirmedRequirement = async () => ({
      ...(await createFakeStages().analyze(context(request("A user can register with an email address.")))),
      runId: "run_1",
      revision: 1,
      confirmedAt: "2026-09-30T10:00:00.000Z",
    });
    p.ports.getSiteAnalysis = async () => ({
      ...siteAnalysis,
      testData: [...siteAnalysis.testData, { key: "city", value: "Springfield", description: "City", source: "GENERATED" as const }],
      appliedKeys: [],
    });
    const stages = createFakeStages();
    let appliedBeforePlanning = -1;
    const plan = stages.plan;
    stages.plan = async (ctx, requirement) => ((appliedBeforePlanning = p.applied.length), plan(ctx, requirement));
    await runExecution(context({ ...request("A user can register with an email address."), testData: { city: "Oslo" } }), p.ports, stages);
    expect(p.applied).toEqual([{ email: "qa.abc123@example.com" }]); // the user's own city is kept
    expect(appliedBeforePlanning).toBe(1);
  });

  it("every criterion blocked: the evidence captured instead of exploring reaches the report", async () => {
    const p = ports("PLANNING");
    p.ports.getConfirmedRequirement = async () => ({
      ...(await createFakeStages().analyze(context(request("A user can add a product to the cart.")))),
      runId: "run_1",
      revision: 1,
      confirmedAt: "2026-09-30T10:00:00.000Z",
    });
    const stages = createFakeStages({ blockAll: true });
    const shot = { id: "step_shot", kind: "screenshot", artifactIds: ["art_1"] } as ExplorationStep;
    stages.captureEvidence = async () => [shot];
    let reportInput: ReportInput | null = null;
    const report = stages.report;
    stages.report = async (ctx, input) => ((reportInput = input), report(ctx, input));

    const { verdict } = await runExecution(context(request("A user can add a product to the cart.")), p.ports, stages);
    expect(verdict).toBe("BLOCKED");
    expect(reportInput!.exploration).toEqual({ steps: [shot], facts: [], stopReason: "BLOCKED_BY_POLICY" });
    const skipped = p.events.filter((e) => e.type === "stage.skipped").map((e) => (e.payload as { stage: string }).stage);
    expect(skipped).toEqual(["EXPLORING", "VERIFYING", "GENERATING_TEST", "RUNNING_PLAYWRIGHT"]);
  });
});
