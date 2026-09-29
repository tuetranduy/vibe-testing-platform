import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NormalizedRequirement, PlannedStep, StoredTestRunRequest, TestPlan } from "@platform/contracts";
import { ArtifactRepository, ExplorationStepRepository, ObservedFactRepository, RunRepository } from "@platform/db";
import { TEST_TENANT_ID, createTestDatabase, type TestDatabase } from "@platform/db/testing";
import { startDemoShop, VALID_EMAIL, VALID_PASSWORD, type RunningDemoShop } from "@platform/demo-shop";
import { LlmClient, type LlmCallRecord } from "@platform/llm";
import { createRunRedactor } from "@platform/security";
import { StagehandExplorer, resolveStagehandExtensionDir } from "@platform/stagehand-adapter";
import { createLocalStorage } from "@platform/storage";
import { createExploreStage, type EventDraft, type StageContext } from "@platform/testing-engine";
import { chromium } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createExplorationStore } from "../../apps/worker/src/exploration";
import { computeExtensionId } from "../../apps/worker/src/sandbox/browser-launcher";
import { openRunSandbox } from "../../apps/worker/src/sandbox/run-sandbox";
import { ScriptedTransport, type ScriptTarget } from "./support/scripted-llm";

/**
 * The real explore stage end to end (Task 14b): real browser sandbox (egress proxy, Chromium with
 * the Stagehand extension, navigation guard) against the in-process demo shop reached as
 * `shop.test`, Stagehand with the real LlmClient over a scripted transport, the executor, and the
 * worker's persistence (PostgreSQL rows + local artifact storage). No API key, no network.
 */

const MODEL = "claude-sonnet-5";
const silent = { info() {}, warn() {}, error() {} };

/** Every `when` is a phrase only our instructions (planned step descriptions / locate prompts) contain. */
const TARGETS: ScriptTarget[] = [
  { when: "click the add to cart button", role: "button", name: "Add to cart", method: "click" },
  { when: "shows: cart badge count", role: "status", name: "Cart items", method: "click" },
  { when: "fill the email field", role: "textbox", name: "Email", method: "fill" },
  { when: "fill the password field", role: "textbox", name: "Password", method: "fill" },
  { when: "click the log in button", role: "button", name: "Log in", method: "click" },
  { when: "click the red button in the danger zone", role: "button", name: "Delete account", method: "click" },
];

const CHROMIUM_EXE = chromium.executablePath();
const CHROMIUM_ROOT = CHROMIUM_EXE.includes(".app/") ? CHROMIUM_EXE.slice(0, CHROMIUM_EXE.indexOf(".app/") + 5) : path.dirname(CHROMIUM_EXE);

function leftovers(runIds: string[]): { processes: string[]; profiles: string[] } {
  const out = execFileSync("ps", ["-ax", "-ww", "-o", "pid=,command="], { encoding: "utf8" });
  const mine = (s: string) => runIds.some((id) => s.includes(`platform-sandbox-${id}`));
  const processes = out.split("\n").filter((l) => {
    const command = l.trim().replace(/^\d+\s+/, "");
    return command.startsWith(CHROMIUM_ROOT) && mine(command);
  });
  const profiles = readdirSync(realpathSync(os.tmpdir())).filter(mine);
  return { processes, profiles };
}

const planned = (id: number, kind: PlannedStep["kind"], description: string, extra: Partial<PlannedStep> = {}): PlannedStep => ({
  id: `PS-${id}`,
  kind,
  description,
  criterionIds: [],
  destructive: false,
  ...extra,
});

function planOf(runId: string, steps: PlannedStep[]): TestPlan {
  return { runId, requirementRevision: 1, scenarios: [{ id: "SC-1", title: "scenario", criterionIds: ["AC-1"], steps }], blockedCriteria: [], stopConditions: [] };
}

const ADD_TO_CART_TEXT = "Add iPhone 17 Pro to the cart. The cart count increases.";
const addToCartRequirement = (runId: string): NormalizedRequirement => ({
  runId,
  revision: 1,
  originalText: ADD_TO_CART_TEXT,
  criteria: [
    {
      id: "AC-1",
      sourceText: "The cart count increases.",
      statement: "The cart count increases after adding iPhone 17 Pro",
      expectedOutcome: { kind: "numeric_delta", before: { key: "cartCount", checkpoint: "before_add" }, after: { key: "cartCount", checkpoint: "after_add" }, delta: 1 },
      preconditions: [],
      ambiguity: null,
    },
  ],
  facts: [
    { key: "cartCount", checkpoint: "before_add", description: "Cart badge count", valueType: "number" },
    { key: "cartCount", checkpoint: "after_add", description: "Cart badge count", valueType: "number" },
  ],
  confirmedAt: "2026-09-26T10:00:00.000Z",
});

describe("real explore stage through the sandbox (demo shop, scripted model)", () => {
  let shop: RunningDemoShop;
  let tdb: TestDatabase;
  let artifactDir: string;
  let extension: { dir: string; id: string };
  const runIds: string[] = [];
  let cleanups: (() => Promise<void> | void)[] = [];

  beforeAll(async () => {
    shop = await startDemoShop({ port: 0, host: "127.0.0.1" });
    tdb = await createTestDatabase();
    artifactDir = mkdtempSync(path.join(os.tmpdir(), "explore-stage-artifacts-"));
    const dir = resolveStagehandExtensionDir();
    extension = { dir, id: computeExtensionId(dir) };
  }, 60_000);

  afterEach(async () => {
    for (const fn of cleanups.splice(0).reverse()) await fn();
  });

  afterAll(async () => {
    await shop?.close();
    await tdb?.drop();
    if (artifactDir) rmSync(artifactDir, { recursive: true, force: true });
    let left = leftovers(runIds);
    for (let i = 0; i < 50 && (left.processes.length > 0 || left.profiles.length > 0); i++) {
      await new Promise((r) => setTimeout(r, 200));
      left = leftovers(runIds);
    }
    expect(left).toEqual({ processes: [], profiles: [] });
  }, 60_000);

  async function setup(opts: { targetPath: string; testData?: Record<string, string>; secrets?: Record<string, string> }) {
    const target = `http://shop.test:${shop.port}${opts.targetPath}`;
    const secrets = opts.secrets ?? {};
    const request: StoredTestRunRequest = {
      targetUrl: target,
      requirement: ADD_TO_CART_TEXT,
      environment: "staging",
      browser: "chromium",
      testData: opts.testData ?? {},
      secretNames: Object.keys(secrets),
      options: {
        maxExplorationSteps: 40,
        maxRunSeconds: 600,
        generatePlaywright: true,
        rerunGeneratedTest: true,
        autoConfirmCriteria: true,
        allowDestructiveActions: false,
        additionalAllowedHosts: [],
      },
    };
    const run = await new RunRepository(tdb.db).create({ tenantId: TEST_TENANT_ID, targetUrl: target, request });
    runIds.push(run.id);

    const events: EventDraft[] = [];
    const controller = new AbortController();
    const redact = createRunRedactor(Object.values(secrets));
    const transport = new ScriptedTransport(TARGETS);
    const records: LlmCallRecord[] = [];
    const llm = new LlmClient({ transport, model: MODEL, recordCall: (c) => void records.push(c), logger: silent, retry: { maxRetries: 0 } });
    const ctx: StageContext = {
      runId: run.id,
      tenantId: TEST_TENANT_ID,
      request,
      signal: controller.signal,
      deadlineAt: new Date(Date.now() + 600_000),
      budgets: { explorationMs: 150_000, rerunMs: 60_000 },
      secrets: { names: Object.keys(secrets), get: (n) => secrets[n] },
      redact,
      publish: async (e) => void events.push(redact(e) as EventDraft),
      addCleanup: (fn) => void cleanups.push(fn),
      boundary: async () => {
        if (controller.signal.aborted) throw controller.signal.reason;
      },
      budgetSignal: (ms) => AbortSignal.any([controller.signal, AbortSignal.timeout(ms)]),
      now: () => new Date(),
      llm,
    };

    const storage = createLocalStorage({ rootDir: artifactDir });
    const resolver = async (host: string) => {
      if (host === "shop.test") return ["127.0.0.1"];
      throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    };
    const explore = createExploreStage({
      openSandbox: (c) => openRunSandbox(c, { resolve: resolver, privateAllowlist: [`shop.test:${shop.port}`], logger: silent, extensions: [extension] }),
      explorer: new StagehandExplorer({ connectTimeoutMs: 90_000, extensionId: extension.id }),
      store: (c) => createExplorationStore({ db: tdb.db, storage, config: { artifactRetentionDays: 30, secretArtifactRetentionDays: 7 } }, c),
    });
    return { run, ctx, events, transport, records, explore, target };
  }

  it(
    "add iPhone 17 Pro to the cart: steps recorded in order with golden-path flags, DOM_VERIFIED cart count before/after, screenshots persisted",
    async () => {
      const { run, ctx, events, transport, records, explore, target } = await setup({ targetPath: "/products/1" });
      const plan = planOf(run.id, [
        planned(1, "navigate", "Open the iPhone 17 Pro product page"),
        planned(2, "capture_checkpoint", "Capture the cart badge before adding", { checkpoint: "before_add" }),
        planned(3, "click", "Click the Add to cart button", { criterionIds: ["AC-1"] }),
        planned(4, "capture_checkpoint", "Capture the cart badge after adding", { checkpoint: "after_add" }),
      ]);

      const outcome = await explore(ctx, plan, addToCartRequirement(run.id));

      expect(outcome.stopReason).toBe("COMPLETED");
      expect(outcome.steps.map((s) => [s.kind, s.plannedStepId, s.outcome, s.onGoldenPath])).toEqual([
        ["navigate", "PS-1", "SUCCESS", true],
        ["extract", "PS-2", "SUCCESS", false],
        ["observe", "PS-2", "SUCCESS", false],
        ["checkpoint", "PS-2", "SUCCESS", true],
        ["observe", "PS-3", "SUCCESS", false],
        ["act", "PS-3", "SUCCESS", true],
        ["extract", "PS-4", "SUCCESS", false],
        ["observe", "PS-4", "SUCCESS", false],
        ["checkpoint", "PS-4", "SUCCESS", true],
      ]);
      const act = outcome.steps[5]!;
      expect(act.element!.candidates[act.element!.chosenIndex]).toEqual({ strategy: "role", role: "button", name: "Add to cart", exact: true });
      expect(act.llm).toBeNull(); // deterministic replay of the observed element
      expect(outcome.steps[4]!.llm).toMatchObject({ model: MODEL, cacheHit: null });
      expect(outcome.steps[0]).toMatchObject({ urlAfter: target });

      // Cart count before/after, read from the DOM with the recorded locator.
      const cart = outcome.facts.filter((f) => f.key === "cartCount");
      expect(cart.map((f) => [f.checkpoint, f.value, f.provenance, f.read?.mode])).toEqual([
        ["before_add", 0, "DOM_VERIFIED", "number"],
        ["after_add", 1, "DOM_VERIFIED", "number"],
      ]);
      expect(cart[0]!.read!.element.candidates[cart[0]!.read!.element.chosenIndex]).toEqual({ strategy: "role", role: "status", name: "Cart items", exact: true });
      expect(outcome.facts.filter((f) => f.key === "url").map((f) => [f.checkpoint, f.provenance])).toEqual([
        ["before_add", "DOM_VERIFIED"],
        ["after_add", "DOM_VERIFIED"],
      ]);
      expect(cart.map((f) => f.stepId)).toEqual([outcome.steps[3]!.id, outcome.steps[8]!.id]);

      // Persisted rows equal the outcome.
      expect(await new ExplorationStepRepository(tdb.db).listByRun(run.id)).toEqual(outcome.steps);
      const facts = await new ObservedFactRepository(tdb.db).listByRun(run.id);
      expect(facts).toHaveLength(4);
      expect(new Set(facts.map((f) => `${f.key}@${f.checkpoint}`))).toEqual(new Set(outcome.facts.map((f) => `${f.key}@${f.checkpoint}`)));
      const artifacts = await new ArtifactRepository(tdb.db).listByRun(run.id);
      expect(artifacts.map((a) => [a.type, a.sensitivity, a.contentType])).toEqual([
        ["SCREENSHOT", "STANDARD", "image/png"],
        ["SCREENSHOT", "STANDARD", "image/png"],
      ]);
      expect(artifacts.every((a) => a.bytes > 1000)).toBe(true);
      expect([outcome.steps[3]!.artifactIds, outcome.steps[8]!.artifactIds].flat()).toEqual(artifacts.map((a) => a.id));

      // Events: step.recorded per step, fact.observed per fact (no values), artifact.created (no URL).
      expect(events.filter((e) => e.type === "step.recorded")).toHaveLength(outcome.steps.length);
      expect(events.filter((e) => e.type === "fact.observed").map((e) => e.payload)).toEqual(
        outcome.facts.map((f) => ({ key: f.key, checkpoint: f.checkpoint, provenance: f.provenance })),
      );
      expect(events.filter((e) => e.type === "artifact.created").map((e) => e.payload)).toEqual(
        artifacts.map((a) => ({ artifactId: a.id, type: "SCREENSHOT", sensitivity: "STANDARD" })),
      );

      // Every model call went through @platform/llm as EXPLORING.
      expect(records.length).toBe(transport.requests.length);
      expect(records.every((r) => r.runId === run.id && r.stage === "EXPLORING" && r.status === "SUCCESS")).toBe(true);
      expect(new Set(transport.requests.map((r) => r.schemaName))).toEqual(new Set(["Observation", "Extraction", "Metadata"])); // never "Act"
    },
    180_000,
  );

  it(
    "login with test data + secret, then 'Delete account' under the default policy → BLOCKED_BY_POLICY, never clicked, secret nowhere",
    async () => {
      const deleteClicksBefore = (shop.server as unknown as { demoShop: { deleteClicks: number } }).demoShop.deleteClicks;
      const { run, ctx, events, transport, explore } = await setup({
        targetPath: "/login",
        testData: { email: VALID_EMAIL },
        secrets: { password: VALID_PASSWORD },
      });
      const plan = planOf(run.id, [
        planned(1, "navigate", "Open the login page"),
        planned(2, "fill", "Fill the email field", { inputRef: { source: "testData", key: "email" } }),
        planned(3, "fill", "Fill the password field", { inputRef: { source: "secret", key: "password" } }),
        planned(4, "login", "Click the Log in button"),
        planned(5, "click", "Click the red button in the danger zone"),
        planned(6, "capture_checkpoint", "Capture the account page", { checkpoint: "after_delete" }),
      ]);
      const requirement: NormalizedRequirement = {
        ...addToCartRequirement(run.id),
        criteria: [{ ...addToCartRequirement(run.id).criteria[0]!, expectedOutcome: { kind: "semantic", description: "the account is deleted" } }],
        facts: [],
      };

      const outcome = await explore(ctx, plan, requirement);

      expect(outcome.stopReason).toBe("BLOCKED_BY_POLICY");
      expect(outcome.steps.map((s) => [s.kind, s.plannedStepId, s.outcome, s.onGoldenPath])).toEqual([
        ["navigate", "PS-1", "SUCCESS", true],
        ["observe", "PS-2", "SUCCESS", false],
        ["fill", "PS-2", "SUCCESS", true],
        ["observe", "PS-3", "SUCCESS", false],
        ["fill", "PS-3", "SUCCESS", true],
        ["observe", "PS-4", "SUCCESS", false],
        ["act", "PS-4", "SUCCESS", true],
        ["observe", "PS-5", "SUCCESS", false],
        ["act", "PS-5", "BLOCKED_BY_POLICY", false],
      ]);
      const blocked = outcome.steps.at(-1)!;
      expect(blocked.blockReason).toBe("DESTRUCTIVE_ACTION_NOT_AUTHORIZED");
      expect(blocked.element!.candidates[blocked.element!.chosenIndex]).toEqual({ strategy: "role", role: "button", name: "Delete account", exact: true });
      expect((shop.server as unknown as { demoShop: { deleteClicks: number } }).demoShop.deleteClicks).toBe(deleteClicksBefore);
      expect(outcome.facts).toEqual([]); // the checkpoint after the blocked step never ran

      // Login (R15 input): the login step's URL changed from /login to /account.
      const login = outcome.steps[6]!;
      expect(new URL(login.urlBefore).pathname).toBe("/login");
      expect(new URL(login.urlAfter).pathname).toBe("/account");
      expect(outcome.steps[4]!.inputRef).toEqual({ source: "secret", key: "password" });

      // D7: the secret is in no provider request, persisted row, or event.
      const persisted = {
        steps: await new ExplorationStepRepository(tdb.db).listByRun(run.id),
        facts: await new ObservedFactRepository(tdb.db).listByRun(run.id),
      };
      expect(persisted.steps).toEqual(outcome.steps);
      expect(events.find((e) => e.type === "step.recorded" && e.payload.outcome === "BLOCKED_BY_POLICY")?.payload).toMatchObject({ blockReason: "DESTRUCTIVE_ACTION_NOT_AUTHORIZED" });
      const everything = JSON.stringify({ requests: transport.requests.map(({ signal: _s, ...r }) => r), persisted, events, outcome });
      expect(everything).not.toContain(VALID_PASSWORD);
    },
    180_000,
  );
});
