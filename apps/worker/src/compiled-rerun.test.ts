import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ExplorationStepSchema,
  GeneratedTestSchema,
  NormalizedRequirementSchema,
  type AcceptanceCriterion,
  type ElementRef,
  type ExplorationStep,
  type GeneratedTest,
  type InputRef,
  type ObservedFact,
  type PlannedStep,
  type TestPlan,
} from "@platform/contracts";
import { ArtifactRepository } from "@platform/db";
import { VALID_EMAIL, VALID_PASSWORD, startDemoShop, type RunningDemoShop } from "@platform/demo-shop";
import { createRunRedactor } from "@platform/security";
import { createLocalStorage, resolveLocalObjectPath } from "@platform/storage";
import {
  captureFact,
  compilePlaywrightTest,
  createRunTestStage,
  fillElement,
  recordElement,
  urlFact,
  verifyCriterion,
  type EventDraft,
  type FactReadMode,
  type StageContext,
} from "@platform/testing-engine";
import { strFromU8, unzipSync } from "fflate";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { silentLogger } from "./deps";
import { createRunTestDeps } from "./rerun";
import { createHarness, seedRun, type WorkerHarness } from "./test-support";

/**
 * Final review, Important 1: the compiler's real output, executed by Playwright (no LLM).
 *
 * A demo-shop flow is recorded the way the executor records it — the real recorder
 * (`recordElement`: ranked candidates, the chosen one resolved on the live page), the real fact
 * reader (`captureFact`) and the real verifier; only the model's choices (which element, which
 * value) are scripted. The flow logs in (email from test data, password from the `password`
 * secret), adds iPhone 17 Pro to the cart and opens the cart. `compilePlaywrightTest` turns it into
 * a test that the worker's real RUNNING_PLAYWRIGHT stage reruns: the rerun's own egress proxy, the
 * runner child process (env allow-list, Chromium sandbox on), the evidence store over the database
 * and local object storage. `?bug=empty_cart` empties the cart page while the badge still counts.
 */

let h: WorkerHarness;
let shop: RunningDemoShop;
let browser: Browser;
let base: string;
let objects: string;

beforeAll(async () => {
  h = await createHarness();
  shop = await startDemoShop();
  browser = await chromium.launch({ headless: true });
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "compiled-rerun-")));
  objects = mkdtempSync(path.join(os.tmpdir(), "compiled-rerun-objects-"));
});
afterAll(async () => {
  await browser?.close();
  await shop?.close();
  await h?.close();
  if (base) rmSync(base, { recursive: true, force: true });
  if (objects) rmSync(objects, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------
// Recording: the discovered flow as the executor records it
// ---------------------------------------------------------------------------------------------

const planned = (id: string, kind: PlannedStep["kind"], extra: Partial<PlannedStep> = {}): PlannedStep => ({
  id,
  kind,
  description: `${kind} ${id}`,
  criterionIds: [],
  destructive: false,
  ...extra,
});

const PLAN: TestPlan = {
  runId: "run_recorded",
  requirementRevision: 1,
  scenarios: [
    {
      id: "SC-1",
      title: "Log in, add a product to the cart, open the cart",
      criterionIds: ["AC-1", "AC-2", "AC-3"],
      steps: [
        planned("PS-1", "navigate"),
        planned("PS-2", "fill", { inputRef: { source: "testData", key: "email" } }),
        planned("PS-3", "fill", { inputRef: { source: "secret", key: "password" } }),
        planned("PS-4", "login"),
        planned("PS-5", "capture_checkpoint", { checkpoint: "logged_in" }),
        planned("PS-6", "navigate"),
        planned("PS-7", "capture_checkpoint", { checkpoint: "before_add" }),
        planned("PS-8", "click"),
        planned("PS-9", "capture_checkpoint", { checkpoint: "after_add" }),
        planned("PS-10", "navigate"),
        planned("PS-11", "capture_checkpoint", { checkpoint: "cart_page" }),
      ],
    },
  ],
  blockedCriteria: [],
  stopConditions: [],
};

const criterion = (id: string, statement: string, expectedOutcome: AcceptanceCriterion["expectedOutcome"]): AcceptanceCriterion => ({
  id,
  sourceText: "x",
  statement,
  expectedOutcome,
  preconditions: [],
  critical: true,
  ambiguity: null,
});

const CRITERIA: AcceptanceCriterion[] = [
  criterion("AC-1", "After logging in, the account page shows the signed-in email", {
    kind: "text_matches",
    fact: { key: "accountEmail", checkpoint: "logged_in" },
    match: { mode: "contains", value: VALID_EMAIL, caseSensitive: false },
  }),
  criterion("AC-2", "The cart count increases after adding a product", {
    kind: "numeric_compare",
    left: { key: "cartCount", checkpoint: "after_add" },
    operator: "gt",
    right: { key: "cartCount", checkpoint: "before_add" },
  }),
  criterion("AC-3", "The cart lists iPhone 17 Pro", {
    kind: "collection_contains",
    collection: { key: "cartItems", checkpoint: "cart_page" },
    item: "iPhone 17 Pro",
    match: "contains",
  }),
  criterion("AC-4", "The shop looks trustworthy", { kind: "semantic", description: "The shop looks trustworthy" }),
];

interface Recording {
  steps: ExplorationStep[];
  facts: ObservedFact[];
  /** The chosen candidate of each recorded element, by what it is. */
  chosen: Record<string, unknown>;
}

/** Walks the healthy demo shop like the executor would, recording steps, elements and facts. */
async function recordFlow(targetUrl: string): Promise<Recording> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const steps: ExplorationStep[] = [];
  const facts: ObservedFact[] = [];
  const chosen: Record<string, unknown> = {};
  const push = (draft: Partial<ExplorationStep> & Pick<ExplorationStep, "kind" | "plannedStepId" | "instruction">, urlBefore: string) => {
    const index = steps.length;
    const step = ExplorationStepSchema.parse({
      id: `st_${index}`,
      runId: "run_recorded",
      index,
      element: null,
      inputRef: null,
      onGoldenPath: true,
      urlBefore,
      urlAfter: page.url(),
      outcome: "SUCCESS",
      blockReason: null,
      error: null,
      startedAt: "2026-09-26T10:00:00.000Z",
      durationMs: 5,
      artifactIds: [],
      llm: null,
      ...draft,
    });
    steps.push(step);
    return step;
  };
  const record = async (what: string, selector: string): Promise<ElementRef> => {
    const ref = await recordElement(page, selector);
    chosen[what] = ref.candidates[ref.chosenIndex];
    return ref;
  };
  const navigate = async (plannedStepId: string, url: string) => {
    const before = page.url();
    await page.goto(url);
    push({ kind: "navigate", plannedStepId, instruction: `Navigate to ${url}` }, before);
  };
  const fill = async (plannedStepId: string, what: string, selector: string, value: string, inputRef: InputRef) => {
    const element = await record(what, selector);
    const before = page.url();
    await fillElement(page, selector, value);
    push({ kind: "fill", plannedStepId, instruction: `Fill ${what}`, element, inputRef }, before);
  };
  const click = async (plannedStepId: string, what: string, selector: string) => {
    const element = await record(what, selector);
    const before = page.url();
    await Promise.all([page.waitForURL(() => true, { waitUntil: "load" }), page.locator(selector).click()]);
    push({ kind: "act", plannedStepId, instruction: `Click ${what}`, element }, before);
  };
  const checkpoint = async (plannedStepId: string, name: string, key: string, selector: string, mode: FactReadMode, modelValue: ObservedFact["value"]) => {
    const step = push({ kind: "checkpoint", plannedStepId, instruction: `Capture checkpoint ${name}` }, page.url());
    const element = await record(`${key}@${name}`, selector);
    facts.push(urlFact(page, { checkpoint: name, stepId: step.id }));
    facts.push(await captureFact(page, { key, checkpoint: name, stepId: step.id, modelValue, element, mode }));
  };

  try {
    await navigate("PS-1", targetUrl);
    await fill("PS-2", "email", "#email", VALID_EMAIL, { source: "testData", key: "email" });
    await fill("PS-3", "password", "#password", VALID_PASSWORD, { source: "secret", key: "password" });
    await click("PS-4", "log in", 'form[aria-label="Log in"] button[type="submit"]');
    await checkpoint("PS-5", "logged_in", "accountEmail", '[data-testid="account-email"]', "text", VALID_EMAIL);
    await navigate("PS-6", `${shop.url}/products/1`);
    await checkpoint("PS-7", "before_add", "cartCount", '[data-testid="cart-count"]', "number", 0);
    await click("PS-8", "add to cart", '[data-testid="add-to-cart"]');
    await checkpoint("PS-9", "after_add", "cartCount", '[data-testid="cart-count"]', "number", 1);
    await navigate("PS-10", `${shop.url}/cart`);
    // The model names the product; the row also shows quantity and price (KI-001): read through the name's element.
    await checkpoint("PS-11", "cart_page", "cartItems", 'ul[aria-label="Cart items list"]', "text_list", ["iPhone 17 Pro"]);
  } finally {
    await context.close();
  }
  return { steps, facts, chosen };
}

function compileRecorded(recording: Recording, targetUrl: string): GeneratedTest {
  const requirement = NormalizedRequirementSchema.parse({
    runId: "run_recorded",
    revision: 1,
    originalText: "x",
    criteria: CRITERIA,
    facts: [
      { key: "accountEmail", checkpoint: "logged_in", description: "The signed-in email", valueType: "string" },
      { key: "cartCount", checkpoint: "before_add", description: "The cart badge count", valueType: "number" },
      { key: "cartCount", checkpoint: "after_add", description: "The cart badge count", valueType: "number" },
      { key: "cartItems", checkpoint: "cart_page", description: "The items listed in the cart", valueType: "string_list" },
    ],
    confirmedAt: "2026-09-26T10:00:00.000Z",
  });
  const provisional = CRITERIA.map((c) =>
    verifyCriterion({ criterion: c, facts: recording.facts, blocked: [], steps: recording.steps, stopReason: "COMPLETED", plan: PLAN }),
  );
  expect(provisional.map((p) => [p.criterionId, p.status])).toEqual([
    ["AC-1", "PASS"],
    ["AC-2", "PASS"],
    ["AC-3", "PASS"],
    ["AC-4", "INCONCLUSIVE"],
  ]);
  const compiled = compilePlaywrightTest({
    requirement,
    plan: PLAN,
    steps: recording.steps,
    facts: recording.facts,
    provisional,
    targetUrl,
    secretNames: ["password"],
    testData: { email: VALID_EMAIL },
  });
  return GeneratedTestSchema.parse({ id: "gt_compiled_rerun", ...compiled });
}

// ---------------------------------------------------------------------------------------------
// The rerun: the worker's real RUNNING_PLAYWRIGHT stage
// ---------------------------------------------------------------------------------------------

async function rerun(test: GeneratedTest) {
  // The run targets the demo shop: the rerun's navigation guard keeps it on that host (KI-029).
  const run = await seedRun(h, { secrets: { password: VALID_PASSWORD }, targetUrl: `${shop.url}/` });
  const events: EventDraft[] = [];
  const cleanups: (() => Promise<void> | void)[] = [];
  const ctx = {
    runId: run.id,
    tenantId: run.tenantId,
    request: run.request,
    signal: new AbortController().signal,
    deadlineAt: null,
    budgets: { explorationMs: 60_000, rerunMs: 60_000 },
    secrets: { names: ["password"], get: (name: string) => (name === "password" ? VALID_PASSWORD : undefined) },
    redact: createRunRedactor([VALID_PASSWORD]),
    publish: async (e: EventDraft) => void events.push(e),
    addCleanup: (fn: () => Promise<void> | void) => void cleanups.push(fn),
  } as unknown as StageContext;
  const storage = createLocalStorage({ rootDir: objects });
  const stage = createRunTestStage({
    ...createRunTestDeps({
      db: h.tdb.db,
      storage,
      logger: silentLogger,
      config: {
        // The demo shop is on loopback: only its exact host:port is admitted (TARGET_PRIVATE_ALLOWLIST).
        privateAllowlist: [`127.0.0.1:${shop.port}`],
        workspaceDir: base,
        artifactRetentionDays: 30,
        secretArtifactRetentionDays: 7,
      },
    }),
    actionTimeoutMs: 5_000,
    expectTimeoutMs: 3_000,
  });
  try {
    const result = await stage(ctx, test);
    const artifacts = await new ArtifactRepository(h.tdb.db).listByRun(run.id);
    return { result, events, artifacts };
  } finally {
    for (const fn of cleanups.reverse()) await fn();
  }
}

// ---------------------------------------------------------------------------------------------

describe("compiled demo-shop flow, rerun by Playwright (real runner, egress proxy, evidence store)", () => {
  let recording: Recording;
  beforeAll(async () => {
    recording = await recordFlow(`${shop.url}/login`);
  }, 30_000);

  it("records what the recorder chooses on the demo shop: semantic locators (role / text), all facts DOM_VERIFIED", () => {
    expect(recording.chosen).toEqual({
      email: { strategy: "role", role: "textbox", name: "Email", exact: true },
      password: { strategy: "role", role: "textbox", name: "Password", exact: true },
      "log in": { strategy: "role", role: "button", name: "Log in", exact: true },
      "accountEmail@logged_in": { strategy: "text", text: VALID_EMAIL, exact: true },
      "cartCount@before_add": { strategy: "role", role: "status", name: "Cart items", exact: true },
      "add to cart": { strategy: "role", role: "button", name: "Add to cart", exact: true },
      "cartCount@after_add": { strategy: "role", role: "status", name: "Cart items", exact: true },
      "cartItems@cart_page": { strategy: "role", role: "list", name: "Cart items list", exact: true },
    });
    expect(recording.facts.filter((f) => f.provenance !== "DOM_VERIFIED")).toEqual([]);
    expect(recording.facts.find((f) => f.key === "cartItems")).toMatchObject({
      value: ["iPhone 17 Pro"],
      read: { mode: "text_list", itemSelector: '[data-testid="cart-item-name"]' },
    });
  });

  it("healthy shop → the compiled test PASSES every compiled criterion; its video and scrubbed trace are kept (V1.3), no screenshot", async () => {
    const test = compileRecorded(recording, `${shop.url}/login`);
    expect(test.compiledCriteria).toEqual(["AC-1", "AC-2", "AC-3"]);
    expect(test.notCompiled.map((n) => n.criterionId)).toEqual(["AC-4"]);
    expect(test.source).not.toContain(VALID_PASSWORD);
    expect(test.dataJson).not.toContain(VALID_PASSWORD);
    expect(test.source).toContain("readItemTexts(");

    const { result, artifacts } = await rerun(test);
    expect(result.errorText).toEqual({});
    expect(result).toMatchObject({ status: "PASSED", perCriterion: { "AC-1": "PASSED", "AC-2": "PASSED", "AC-3": "PASSED" } });
    // The run records video and trace (the V1.3 default): a passing rerun keeps both; a screenshot only on failure.
    expect(artifacts.map((a) => a.type).sort()).toEqual(["TRACE", "VIDEO"]);
    expect([...result.artifactIds].sort()).toEqual(artifacts.map((a) => a.id).sort());
    const trace = artifacts.find((a) => a.type === "TRACE")!;
    const text = Object.values(unzipSync(readFileSync(resolveLocalObjectPath(objects, trace.objectKey)))).map((b) => strFromU8(b, true)).join("\n");
    expect(text).not.toContain(VALID_PASSWORD);
  }, 60_000);

  it("?bug=empty_cart → the cart-contents criterion ASSERTION_FAILED, the others PASSED; the stored trace has no password", async () => {
    const test = compileRecorded(recording, `${shop.url}/login?bug=empty_cart`);
    const { result, events, artifacts } = await rerun(test);
    expect(result.status).toBe("FAILED");
    expect(result.perCriterion).toEqual({ "AC-1": "PASSED", "AC-2": "PASSED", "AC-3": "ASSERTION_FAILED" });
    expect(Object.keys(result.errorText)).toEqual(["AC-3"]);
    expect(result.errorText["AC-3"]).toContain("[AC-3] The cart lists iPhone 17 Pro");

    // Evidence: trace, screenshot and video, all SECRET_BEARING (the run has a secret).
    expect(artifacts.map((a) => a.type).sort()).toEqual(["SCREENSHOT", "TRACE", "VIDEO"]);
    expect(new Set(artifacts.map((a) => a.sensitivity))).toEqual(new Set(["SECRET_BEARING"]));
    expect([...result.artifactIds].sort()).toEqual(artifacts.map((a) => a.id).sort());
    expect(events.filter((e) => e.type === "artifact.created")).toHaveLength(3);

    // The stored trace recorded the password fill, with the value scrubbed.
    const trace = artifacts.find((a) => a.type === "TRACE")!;
    const entries = unzipSync(readFileSync(resolveLocalObjectPath(objects, trace.objectKey)));
    const text = Object.values(entries).map((b) => strFromU8(b, true)).join("\n");
    expect(text).toContain("[REDACTED]");
    for (const form of [VALID_PASSWORD, encodeURIComponent(VALID_PASSWORD), Buffer.from(VALID_PASSWORD).toString("base64")]) {
      expect(text).not.toContain(form);
    }
  }, 60_000);
});
