/**
 * @live — real model (LLM_PROVIDER=gemini, or anthropic when unset or fake) + real Stagehand + real
 * sandbox, against the in-process demo shop only (reached as `shop.test`; nothing else is reachable
 * through the egress proxy).
 *
 *   ANTHROPIC_API_KEY=… pnpm test:live -- stagehand-smoke                       (optional: LLM_MODEL=…)
 *   LLM_PROVIDER=gemini GEMINI_API_KEY=… pnpm test:live -- stagehand-smoke      (optional: LLM_MODEL=…, GEMINI_THINKING_LEVEL=…)
 *
 * Plan: open the product page → read the cart badge → find and click "Add to cart" → read the
 * badge again; the count after adding must be 1, read from the DOM (DOM_VERIFIED).
 * Skipped (with the reason on stderr) when the provider's API key is not set.
 */
import { loadLiveLlmEnv, resolveEnvLlmChoice } from "@platform/config";
import type { ExplorationStep, NormalizedRequirement, ObservedFact, StoredTestRunRequest, TestPlan } from "@platform/contracts";
import { startDemoShop, type RunningDemoShop } from "@platform/demo-shop";
import { LlmClient, createTransport, type LlmCallRecord } from "@platform/llm";
import { createRunRedactor } from "@platform/security";
import { StagehandExplorer, resolveStagehandExtensionDir } from "@platform/stagehand-adapter";
import { createExploreStage, type EventDraft, type ExplorationStore, type StageContext } from "@platform/testing-engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeExtensionId } from "../../apps/worker/src/sandbox/browser-launcher";
import { openRunSandbox } from "../../apps/worker/src/sandbox/run-sandbox";

// Only an unset API key skips the smoke; any other bad LLM setting fails the file.
const LIVE = loadLiveLlmEnv();
const LLM = "missingKey" in LIVE ? null : LIVE;
const SKIP = "missingKey" in LIVE ? `${LIVE.missingKey} is not set` : null;
const RUN_ID = "run_stagehand_live_smoke";
const silent = { info() {}, warn() {}, error() {} };

if (SKIP) {
  process.stderr.write(
    `[stagehand-smoke] SKIPPED: ${SKIP} (run: ANTHROPIC_API_KEY=… or LLM_PROVIDER=gemini GEMINI_API_KEY=… pnpm test:live -- stagehand-smoke)\n`,
  );
}


describe("@live Stagehand smoke against the demo shop", () => {
  let shop: RunningDemoShop;
  const cleanups: (() => Promise<void> | void)[] = [];

  beforeAll(async () => {
    if (SKIP) return;
    shop = await startDemoShop({ port: 0, host: "127.0.0.1" });
  });

  afterAll(async () => {
    for (const fn of cleanups.splice(0).reverse()) await fn();
    await shop?.close();
  });

  it.skipIf(SKIP !== null)("navigate → find 'Add to cart' → click → cart badge reads 1 (DOM_VERIFIED)", async () => {
    const target = `http://shop.test:${shop.port}/products/1`;
    const request: StoredTestRunRequest = {
      targetUrl: target,
      requirement: "Add iPhone 17 Pro to the cart. The cart count increases.",
      environment: "staging",
      browser: "chromium",
      testData: {},
      secretNames: [],
      options: {
        maxExplorationSteps: 20,
        maxRunSeconds: 300,
        generatePlaywright: false,
        rerunGeneratedTest: false,
        autoConfirmCriteria: true,
        allowDestructiveActions: false,
        additionalAllowedHosts: [],
      },
    };
    const records: LlmCallRecord[] = [];
    const env = LLM!;
    const choice = resolveEnvLlmChoice(env);
    const llm = new LlmClient({
      transport: createTransport({ provider: choice.provider, apiKey: env.LLM_PROVIDER === "gemini" ? env.GEMINI_API_KEY : env.ANTHROPIC_API_KEY }),
      model: choice.model,
      reasoning: choice.reasoning,
      logger: silent,
      recordCall: (c) => void records.push(c),
    });
    const controller = new AbortController();
    const redact = createRunRedactor([]);
    const events: EventDraft[] = [];
    const ctx: StageContext = {
      runId: RUN_ID,
      tenantId: "t_default",
      request,
      signal: controller.signal,
      deadlineAt: new Date(Date.now() + 170_000),
      budgets: { explorationMs: 150_000, rerunMs: 0 },
      secrets: { names: [], get: () => undefined },
      redact,
      publish: async (e) => void events.push(e),
      addCleanup: (fn) => void cleanups.push(fn),
      boundary: async () => {
        if (controller.signal.aborted) throw controller.signal.reason;
      },
      budgetSignal: (ms) => AbortSignal.any([controller.signal, AbortSignal.timeout(ms)]),
      now: () => new Date(),
      llm,
    };

    const dir = resolveStagehandExtensionDir();
    const extension = { dir, id: computeExtensionId(dir) };
    const steps: ExplorationStep[] = [];
    const facts: ObservedFact[] = [];
    const store: ExplorationStore = {
      saveStep: async (s) => void steps.push(s),
      saveFact: async (f) => void facts.push(f),
      saveScreenshot: async () => ({ artifactId: `art_${steps.length}` }),
    };
    const explore = createExploreStage({
      openSandbox: (c) =>
        openRunSandbox(c, {
          resolve: async (host) => {
            if (host === "shop.test") return ["127.0.0.1"];
            throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: "ENOTFOUND" });
          },
          privateAllowlist: [`shop.test:${shop.port}`],
          logger: silent,
          extensions: [extension],
        }),
      explorer: new StagehandExplorer({ extensionId: extension.id, connectTimeoutMs: 90_000 }),
      store: () => store,
    });

    const plan: TestPlan = {
      runId: RUN_ID,
      requirementRevision: 1,
      scenarios: [
        {
          id: "SC-1",
          title: "Add a product to the cart",
          criterionIds: ["AC-1"],
          steps: [
            { id: "PS-1", kind: "navigate", description: "Open the product page", criterionIds: [], destructive: false },
            { id: "PS-2", kind: "capture_checkpoint", description: "Capture the cart badge before adding", checkpoint: "before_add", criterionIds: ["AC-1"], destructive: false },
            { id: "PS-3", kind: "click", description: "Click the Add to cart button", criterionIds: ["AC-1"], destructive: false },
            { id: "PS-4", kind: "capture_checkpoint", description: "Capture the cart badge after adding", checkpoint: "after_add", criterionIds: ["AC-1"], destructive: false },
          ],
        },
      ],
      blockedCriteria: [],
      stopConditions: [],
    };
    const requirement: NormalizedRequirement = {
      runId: RUN_ID,
      revision: 1,
      originalText: request.requirement,
      criteria: [
        {
          id: "AC-1",
          sourceText: "The cart count increases.",
          statement: "The cart count increases after adding the product",
          expectedOutcome: { kind: "numeric_delta", before: { key: "cartCount", checkpoint: "before_add" }, after: { key: "cartCount", checkpoint: "after_add" }, delta: 1 },
          preconditions: [],
          ambiguity: null,
        },
      ],
      facts: [
        { key: "cartCount", checkpoint: "before_add", description: "The number shown in the cart badge in the header", valueType: "number" },
        { key: "cartCount", checkpoint: "after_add", description: "The number shown in the cart badge in the header", valueType: "number" },
      ],
      confirmedAt: new Date().toISOString(),
    };

    const outcome = await explore(ctx, plan, requirement);

    expect(outcome.stopReason).toBe("COMPLETED");
    const clicked = outcome.steps.find((s) => s.plannedStepId === "PS-3" && s.onGoldenPath);
    expect(clicked).toMatchObject({ kind: "act", outcome: "SUCCESS" });
    const after = outcome.facts.find((f) => f.key === "cartCount" && f.checkpoint === "after_add");
    expect(after).toMatchObject({ value: 1, provenance: "DOM_VERIFIED" });
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((r) => r.runId === RUN_ID && r.stage === "EXPLORING")).toBe(true);
  }, 180_000);
});
