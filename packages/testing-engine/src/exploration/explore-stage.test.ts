import { BrowserProviderError, StorageError, type NormalizedRequirement, type TestPlan } from "@platform/contracts";
import type { ExplorerSession, ExplorerStartInput } from "@platform/stagehand-adapter/browser-explorer";
import type { Page } from "playwright-core";
import { describe, expect, it } from "vitest";
import { errorCategoryOf } from "../orchestrator/errors";
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

function harness(opts: { startDelayMs?: number; openError?: unknown; startError?: unknown; allowDestructiveActions?: boolean } = {}) {
  const run = new AbortController();
  const budget = new AbortController();
  const cleanups: (() => unknown)[] = [];
  const log: string[] = [];
  const logged: { obj: object; msg?: string }[] = [];
  const redact = (v: unknown) => v;
  const ctx = {
    runId: "run_stage",
    request: { targetUrl: "https://shop.test/", environment: "staging", testData: {}, secretNames: [], options: { maxExplorationSteps: 10, allowDestructiveActions: opts.allowDestructiveActions ?? false } },
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
      if (opts.openError) throw opts.openError;
      return sandbox;
    },
    explorer: {
      start: async (input) => {
        started = input;
        if (opts.startError) throw opts.startError;
        if (opts.startDelayMs) {
          budget.abort(new DOMException("timed out", "TimeoutError"));
          throw budget.signal.reason;
        }
        return session;
      },
    },
    logger: { error: (obj, msg) => void logged.push({ obj, msg }) },
    store: () => ({ saveStep: async () => {}, saveFact: async () => {}, saveScreenshot: async () => ({ artifactId: "a" }) }),
  });
  return { ctx, run, budget, cleanups, log, logged, stage, started: () => started, redact };
}

describe("createExploreStage", () => {
  it("opens the sandbox, starts the explorer on the budget signal with the run redactor, explores, and releases everything", async () => {
    const h = harness();
    const outcome = await h.stage(h.ctx, plan, requirement);
    expect(outcome.stopReason).toBe("COMPLETED");
    expect(outcome.steps.map((s) => s.kind)).toEqual(["navigate"]);
    expect(h.started()).toMatchObject({ page: expect.objectContaining({ cdpUrl: "http://127.0.0.1:1" }), runId: "run_stage", signal: h.budget.signal, redact: h.redact, allowDestructive: false });
    expect(h.log).toEqual(["sandbox.open", "navigate https://shop.test/", "session.close", "session.close", "sandbox.close"]);
    expect(h.cleanups).toHaveLength(2); // sandbox + session, for abandoned stages
  });

  it("tells the explorer the run allows destructive actions when it does", async () => {
    const h = harness({ allowDestructiveActions: true });
    await h.stage(h.ctx, plan, requirement);
    expect(h.started()).toMatchObject({ allowDestructive: true });
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

  const CHROMIUM_STDERR =
    "Chromium exited during launch: No usable sandbox! ... If you want to live dangerously and need an immediate workaround, you can try using --no-sandbox.";

  it("the sandbox fails to open → BROWSER_PROVIDER with a clean message; the Chromium stderr goes to the log only", async () => {
    const cause = new Error(CHROMIUM_STDERR);
    const h = harness({ openError: cause });
    const err = await h.stage(h.ctx, plan, requirement).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrowserProviderError);
    expect(errorCategoryOf(err)).toBe("BROWSER_PROVIDER");
    expect((err as Error).message).toBe("Browser sandbox failed to start");
    expect((err as Error).cause).toBe(cause);
    expect(h.logged).toEqual([{ obj: { err: cause, runId: "run_stage" }, msg: "browser sandbox failed to start" }]);
  });

  it("the explorer fails to start with a plain error → BROWSER_PROVIDER, sandbox released", async () => {
    const cause = new Error("Stagehand extension not found (set STAGEHAND_EXTENSION_DIRECTORY_PATH or install @browserbasehq/stagehand)");
    const h = harness({ startError: cause });
    const err = await h.stage(h.ctx, plan, requirement).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrowserProviderError);
    expect((err as Error).message).toBe("Browser explorer failed to start");
    expect((err as Error).cause).toBe(cause);
    expect(h.log).toContain("sandbox.close");
    expect(h.logged.map((l) => l.msg)).toEqual(["browser explorer failed to start"]);
  });

  it("typed engine errors while starting pass through unchanged", async () => {
    const typed = new StorageError("disk full");
    const h = harness({ openError: typed });
    await expect(h.stage(h.ctx, plan, requirement)).rejects.toBe(typed);
  });
});
