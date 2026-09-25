/**
 * Deterministic stand-in engine used until the real stages land (Tasks 10–18), and by lifecycle
 * tests forever after. Every behavior the worker must survive can be switched on with an option.
 */
import type {
  CriterionResult,
  ExplorationOutcome,
  ExplorationStep,
  GeneratedTest,
  NormalizedRequirement,
  ObservedFact,
  ProvisionalResult,
  RerunResult,
  TestPlan,
  TestReport,
} from "@platform/contracts";
import { aggregateVerdict } from "../verification/aggregate";
import type { EngineStages, RequirementDraft, StageContext } from "./stages";

export interface FakeBrowser {
  closeCount: number;
  close(): Promise<void>;
}

export interface FakeEngineOptions {
  /** Throw this error when the named stage starts. */
  failAt?: { stage: keyof EngineStages; error: Error };
  /** Plan blocks every criterion (MISSING_SECRET). */
  blockAll?: boolean;
  explorationSteps?: number;
  stepDelayMs?: number;
  /** Explore until the exploration budget signal fires, then stop with EXPLORATION_BUDGET_EXHAUSTED. */
  exploreUntilBudget?: boolean;
  /** Sleep on the run signal instead of the budget signal (simulates an explorer that overruns). */
  ignoreBudget?: boolean;
  /** Called at the start of each exploration step (after the boundary check). */
  onStep?: (index: number) => void | Promise<void>;
  /** Provisional status for every non-blocked criterion. */
  provisionalStatus?: "PASS" | "FAIL" | "INCONCLUSIVE";
  analyzeDelayMs?: number;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });

export function createFakeStages(opts: FakeEngineOptions = {}): EngineStages & { browsers: FakeBrowser[] } {
  const browsers: FakeBrowser[] = [];
  const maybeFail = (stage: keyof EngineStages) => {
    if (opts.failAt?.stage === stage) throw opts.failAt.error;
  };

  const stages: EngineStages & { browsers: FakeBrowser[] } = {
    browsers,

    async analyze(ctx): Promise<RequirementDraft> {
      maybeFail("analyze");
      if (opts.analyzeDelayMs) await sleep(opts.analyzeDelayMs, ctx.signal);
      const text = ctx.request.requirement;
      return {
        originalText: text,
        criteria: [
          {
            id: "AC-1",
            sourceText: text,
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
            sourceText: text,
            statement: "The cart lists the selected product",
            expectedOutcome: {
              kind: "collection_contains",
              collection: { key: "cartItems", checkpoint: "cart_page" },
              item: "iPhone 17 Pro",
              match: "contains",
            },
            preconditions: [],
            ambiguity: null,
          },
        ],
        facts: [
          { key: "cartCount", checkpoint: "before_add", description: "Cart badge count", valueType: "number" },
          { key: "cartCount", checkpoint: "after_add", description: "Cart badge count", valueType: "number" },
          { key: "cartItems", checkpoint: "cart_page", description: "Names of items in the cart", valueType: "string_list" },
        ],
      };
    },

    async plan(ctx, requirement): Promise<TestPlan> {
      maybeFail("plan");
      const ids = requirement.criteria.map((c) => c.id);
      return {
        runId: ctx.runId,
        requirementRevision: requirement.revision,
        scenarios: [
          {
            id: "SC-1",
            title: "Add a product to the cart",
            criterionIds: ids,
            steps: [
              { id: "PS-1", kind: "navigate", description: "Open the home page", criterionIds: [], destructive: false },
              { id: "PS-2", kind: "capture_checkpoint", description: "Capture before add", checkpoint: "before_add", criterionIds: ["AC-1"], destructive: false },
              { id: "PS-3", kind: "click", description: "Click Add to cart", criterionIds: ids, destructive: false },
              { id: "PS-4", kind: "capture_checkpoint", description: "Capture after add", checkpoint: "after_add", criterionIds: ["AC-1"], destructive: false },
            ],
          },
        ],
        blockedCriteria: opts.blockAll
          ? ids.map((criterionId) => ({ criterionId, reason: "MISSING_SECRET" as const, detail: "No password provided" }))
          : [],
        stopConditions: [],
      };
    },

    async explore(ctx, plan): Promise<ExplorationOutcome> {
      maybeFail("explore");
      const browser: FakeBrowser = {
        closeCount: 0,
        async close() {
          this.closeCount++;
        },
      };
      browsers.push(browser);
      let closed = false;
      ctx.addCleanup(async () => {
        if (!closed) {
          closed = true;
          await browser.close();
        }
      });

      const budget = ctx.budgetSignal(ctx.budgets.explorationMs);
      const max = opts.exploreUntilBudget ? Number.POSITIVE_INFINITY : (opts.explorationSteps ?? 3);
      const steps: ExplorationStep[] = [];
      let stopReason: ExplorationOutcome["stopReason"] = "COMPLETED";
      for (let i = 0; i < max; i++) {
        await ctx.boundary(); // cancel / hard deadline → throws
        if (budget.aborted && !opts.ignoreBudget) {
          stopReason = "EXPLORATION_BUDGET_EXHAUSTED";
          break;
        }
        if (i >= ctx.request.options.maxExplorationSteps) {
          stopReason = "STEP_LIMIT_REACHED";
          break;
        }
        await opts.onStep?.(i);
        if (opts.stepDelayMs) {
          try {
            await sleep(opts.stepDelayMs, opts.ignoreBudget ? ctx.signal : budget);
          } catch {
            await ctx.boundary();
            stopReason = "EXPLORATION_BUDGET_EXHAUSTED";
            break;
          }
        }
        const step: ExplorationStep = {
          id: `st_${ctx.runId}_${i}`,
          runId: ctx.runId,
          index: i,
          plannedStepId: plan.scenarios[0]!.steps[i % plan.scenarios[0]!.steps.length]!.id,
          kind: "act",
          instruction: `Fake step ${i}`,
          element: null,
          inputRef: null,
          onGoldenPath: true,
          urlBefore: ctx.request.targetUrl,
          urlAfter: ctx.request.targetUrl,
          outcome: "SUCCESS",
          blockReason: null,
          error: null,
          startedAt: ctx.now().toISOString(),
          durationMs: opts.stepDelayMs ?? 0,
          artifactIds: [],
          llm: null,
        };
        steps.push(step);
        await ctx.publish({
          type: "step.recorded",
          message: `Step ${i + 1}: ${step.instruction}`,
          payload: { stepId: step.id, index: i, kind: step.kind, outcome: step.outcome, blockReason: null },
        });
      }
      closed = true;
      await browser.close();

      const element = { candidates: [{ strategy: "testId" as const, value: "cart-count" }], chosenIndex: 0, framePath: [] };
      const facts: ObservedFact[] =
        stopReason === "COMPLETED"
          ? [
              { key: "cartCount", checkpoint: "before_add", value: 0, provenance: "DOM_VERIFIED", read: { element, mode: "number" }, stepId: steps[0]?.id ?? "none" },
              { key: "cartCount", checkpoint: "after_add", value: 1, provenance: "DOM_VERIFIED", read: { element, mode: "number" }, stepId: steps.at(-1)?.id ?? "none" },
              { key: "cartItems", checkpoint: "cart_page", value: ["iPhone 17 Pro"], provenance: "DOM_VERIFIED", read: { element, mode: "text_list" }, stepId: steps.at(-1)?.id ?? "none" },
            ]
          : [];
      return { steps, facts, stopReason };
    },

    verify(_ctx, requirement, plan, exploration): ProvisionalResult[] {
      maybeFail("verify");
      const blocked = new Map(plan.blockedCriteria.map((b) => [b.criterionId, b]));
      return requirement.criteria.map((c): ProvisionalResult => {
        const b = blocked.get(c.id);
        if (b) return { criterionId: c.id, status: "BLOCKED", reason: b.reason, factRefs: [], expected: c.statement, actual: null };
        if (!exploration || exploration.stopReason !== "COMPLETED") {
          const reason =
            exploration?.stopReason === "EXPLORATION_BUDGET_EXHAUSTED" || exploration?.stopReason === "STEP_LIMIT_REACHED"
              ? exploration.stopReason
              : "FACT_NOT_OBSERVED";
          return { criterionId: c.id, status: "INCONCLUSIVE", reason, factRefs: [], expected: c.statement, actual: null };
        }
        const status = opts.provisionalStatus ?? "PASS";
        return {
          criterionId: c.id,
          status,
          reason: status === "INCONCLUSIVE" ? "FACT_NOT_OBSERVED" : null,
          factRefs: [],
          expected: c.statement,
          actual: status === "PASS" ? c.statement : "not observed as expected",
        };
      });
    },

    async generateTest(ctx, input): Promise<GeneratedTest | null> {
      maybeFail("generateTest");
      const compiled = input.provisional.filter((r) => r.status === "PASS" || r.status === "FAIL").map((r) => r.criterionId);
      return {
        id: `gt_${ctx.runId}`,
        source: `import { test } from "@playwright/test";\n// fake generated test for ${compiled.join(", ")}\n`,
        helpersSource: "export {};\n",
        dataJson: JSON.stringify({ targetUrl: ctx.request.targetUrl }),
        compiledCriteria: compiled,
        notCompiled: input.provisional
          .filter((r) => !compiled.includes(r.criterionId))
          .map((r) => ({ criterionId: r.criterionId, reason: `provisional ${r.status}` })),
        notes: [],
      };
    },

    async runTest(_ctx, test): Promise<RerunResult> {
      maybeFail("runTest");
      const status = opts.provisionalStatus === "FAIL" ? "ASSERTION_FAILED" : "PASSED";
      return {
        status: status === "PASSED" ? "PASSED" : "FAILED",
        perCriterion: Object.fromEntries(test.compiledCriteria.map((id) => [id, status])),
        durationMs: 5,
        errorText: {},
      };
    },

    async report(ctx, input): Promise<TestReport> {
      maybeFail("report");
      // Minimal stand-in for Task 18 reconciliation: rerun-confirmed PASS/FAIL, else provisional.
      const criteria: CriterionResult[] = input.provisional.map((p) => {
        const rerunOutcome = input.rerun?.perCriterion[p.criterionId] ?? "UNAVAILABLE";
        const decided = p.status === "PASS" || p.status === "FAIL";
        return {
          ...p,
          verdictSource: decided ? (rerunOutcome === "UNAVAILABLE" ? "EXPLORATION_ONLY" : "PLAYWRIGHT_RERUN") : null,
          rerunOutcome,
          provisional: { status: p.status, reason: p.reason },
          evidenceArtifactIds: [],
          relatedStepIds: [],
          aiNote: null,
        };
      });
      const count = (s: string) => criteria.filter((c) => c.status === s).length;
      const finishedAt = ctx.now();
      return {
        runId: ctx.runId,
        lifecycle: "GENERATING_REPORT",
        verdict: aggregateVerdict(criteria),
        error: null,
        partial: false,
        targetUrl: ctx.request.targetUrl,
        requirement: input.requirement,
        summary: {
          totalCriteria: criteria.length,
          passed: count("PASS"),
          failed: count("FAIL"),
          blocked: count("BLOCKED"),
          inconclusive: count("INCONCLUSIVE"),
          confirmedByRerun: criteria.filter((c) => c.verdictSource === "PLAYWRIGHT_RERUN").length,
        },
        criteria,
        generatedTest: input.generatedTest && {
          id: input.generatedTest.id,
          source: input.generatedTest.source,
          compiledCriteria: input.generatedTest.compiledCriteria,
          notCompiled: input.generatedTest.notCompiled,
          notes: input.generatedTest.notes,
        },
        playwright: input.rerun && { status: input.rerun.status, durationMs: input.rerun.durationMs },
        diagnostics: [],
        usage: { llmCalls: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
        startedAt: input.startedAt?.toISOString() ?? null,
        finishedAt: finishedAt.toISOString(),
        durationMs: input.startedAt ? finishedAt.getTime() - input.startedAt.getTime() : null,
      };
    },
  };
  return stages;
}

export type { NormalizedRequirement };
