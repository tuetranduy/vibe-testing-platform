import {
  CancelledError,
  ContractError,
  SuggestionSetSchema,
  type NormalizedRequirement,
  type RunLifecycle,
  type StoredTestRunRequest,
  type SuggestionSet,
} from "@platform/contracts";
import { describe, expect, it } from "vitest";
import { createFakeStages, fakeSuggestionSet } from "./fake-stages";
import { runAnalysis, runSurvey, type RunPorts, type TransitionPatch } from "./orchestrator";
import type { EventDraft, StageContext } from "./stages";

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
    saveSuggestions: async (draft) => (saved = SuggestionSetSchema.parse({ ...draft, selected: null })),
  };
  return { ports: p, events, transitions, saved: () => saved, requirement: () => requirement, lifecycle: () => lifecycle };
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
