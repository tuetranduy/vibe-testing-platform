import type { NormalizedRequirement, TestPlan } from "@platform/contracts";
import type { ExplorerSession, ExplorerStartInput } from "@platform/stagehand-adapter/browser-explorer";
import type { Page } from "playwright-core";
import { describe, expect, it } from "vitest";
import type { StageContext } from "../orchestrator/stages";
import { createExploreStage, type ExplorationSandbox } from "./explore-stage";

const plan = {
  runId: "run_stage",
  requirementRevision: 1,
  scenarios: [{ id: "SC-1", title: "t", criterionIds: ["AC-1"], steps: [{ id: "PS-1", kind: "navigate", description: "Open the shop", criterionIds: [], destructive: false }] }],
  blockedCriteria: [],
  stopConditions: [],
} as TestPlan;
const requirement = { facts: [], criteria: [] } as unknown as NormalizedRequirement;

function harness(opts: { startDelayMs?: number } = {}) {
  const run = new AbortController();
  const budget = new AbortController();
  const cleanups: (() => unknown)[] = [];
  const log: string[] = [];
  const redact = (v: unknown) => v;
  const ctx = {
    runId: "run_stage",
    request: { targetUrl: "https://shop.test/", environment: "staging", testData: {}, secretNames: [], options: { maxExplorationSteps: 10, allowDestructiveActions: false } },
    signal: run.signal,
    deadlineAt: null,
    budgets: { explorationMs: 1000, rerunMs: 1000 },
    secrets: { names: [], get: () => undefined },
    redact,
    publish: async () => {},
    addCleanup: (fn: () => unknown) => void cleanups.push(fn),
    boundary: async () => {},
    budgetSignal: () => budget.signal,
    now: () => new Date(),
  } as unknown as StageContext;
  const sandbox = { cdpUrl: "http://127.0.0.1:1", extensionIds: ["x"], page: {} as Page, close: async () => void log.push("sandbox.close") } as ExplorationSandbox;
  let started: ExplorerStartInput | undefined;
  const session = {
    page: { url: () => "https://shop.test/", isClosed: () => false, waitForLoadState: async () => {} } as unknown as Page,
    navigate: async (url: string) => {
      log.push(`navigate ${url}`);
      return { url };
    },
    close: async () => void log.push("session.close"),
  } as unknown as ExplorerSession;
  const stage = createExploreStage({
    openSandbox: async (c) => {
      expect(c).toBe(ctx);
      log.push("sandbox.open");
      return sandbox;
    },
    explorer: {
      start: async (input) => {
        started = input;
        if (opts.startDelayMs) {
          budget.abort(new DOMException("timed out", "TimeoutError"));
          throw budget.signal.reason;
        }
        return session;
      },
    },
    store: () => ({ saveStep: async () => {}, saveFact: async () => {}, saveScreenshot: async () => ({ artifactId: "a" }) }),
  });
  return { ctx, run, budget, cleanups, log, stage, started: () => started, redact };
}

describe("createExploreStage", () => {
  it("opens the sandbox, starts the explorer on the budget signal with the run redactor, explores, and releases everything", async () => {
    const h = harness();
    const outcome = await h.stage(h.ctx, plan, requirement);
    expect(outcome.stopReason).toBe("COMPLETED");
    expect(outcome.steps.map((s) => s.kind)).toEqual(["navigate"]);
    expect(h.started()).toMatchObject({ page: expect.objectContaining({ cdpUrl: "http://127.0.0.1:1" }), runId: "run_stage", signal: h.budget.signal, redact: h.redact });
    expect(h.log).toEqual(["sandbox.open", "navigate https://shop.test/", "session.close", "session.close", "sandbox.close"]);
    expect(h.cleanups).toHaveLength(2); // sandbox + session, for abandoned stages
  });

  it("budget exhausted while the explorer starts → EXPLORATION_BUDGET_EXHAUSTED with nothing explored, sandbox closed", async () => {
    const h = harness({ startDelayMs: 1 });
    await expect(h.stage(h.ctx, plan, requirement)).resolves.toEqual({ steps: [], facts: [], stopReason: "EXPLORATION_BUDGET_EXHAUSTED" });
    expect(h.log).toEqual(["sandbox.open", "sandbox.close"]);
  });

  it("run cancelled → throws the abort reason", async () => {
    const h = harness();
    const reason = new Error("cancelled");
    h.run.abort(reason);
    await expect(h.stage(h.ctx, plan, requirement)).rejects.toBe(reason);
    expect(h.log).toContain("sandbox.close");
  });
});
