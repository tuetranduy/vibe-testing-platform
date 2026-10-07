import type { FactValue, LlmChoice, RunLifecycle, StoredTestRunRequest, SuggestionSetDraft, TestEvent } from "@platform/contracts";
import { EventRepository, RequirementRepository, RunRepository, SecretRepository, SuggestionRepository, type TestRun } from "@platform/db";
import { TEST_TENANT_ID, createTestDatabase, type TestDatabase } from "@platform/db/testing";
import { runCancelChannel, type RunQueue } from "@platform/event-bus";
import { encryptSecret } from "@platform/security";
import type { ExplorerSession } from "@platform/stagehand-adapter";
import {
  createFakeStages,
  factFromReadings,
  type EngineStages,
  type ExploreStageDeps,
  type FakeEngineOptions,
  type RecorderPort,
} from "@platform/testing-engine";
import { Redis } from "ioredis";
import type { Page } from "playwright-core";
import { CancelWatcher } from "./cancel-watcher";
import { silentLogger, type WorkerDeps } from "./deps";
import type { Engines } from "./engine";
import type { RunLlmFactory } from "./run-llm";

export const SECRETS_KEY = Buffer.alloc(32, 5);
// A dedicated logical DB by default: tests never touch DB 0, where a developer's worker takes jobs.
export const REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6379/15";

export class FakeQueue implements RunQueue {
  analyze: string[] = [];
  execute: string[] = [];
  waiting = new Set<string>();
  analyzePending = new Set<string>();
  async enqueueAnalyze(runId: string) {
    this.analyze.push(runId);
  }
  rerun: string[] = [];
  rerunPending = new Set<string>();
  async enqueueRerun(runId: string) {
    if ((this as { fail?: boolean }).fail) throw new Error("queue down");
    this.rerun.push(runId);
  }
  async isRerunPending(runId: string) {
    return this.rerunPending.has(runId);
  }
  async enqueueExecute(runId: string) {
    this.execute.push(runId);
  }
  async isExecuteWaiting(runId: string) {
    return this.waiting.has(runId);
  }
  async isAnalyzePending(runId: string) {
    return this.analyzePending.has(runId);
  }
  afterSelection: string[] = [];
  afterSelectionWaiting = new Set<string>();
  async enqueueAnalyzeAfterSelection(runId: string) {
    this.afterSelection.push(runId);
  }
  async isAnalyzeAfterSelectionWaiting(runId: string) {
    return this.afterSelectionWaiting.has(runId);
  }
  async close() {}
}

/** Engines that give every run `stages`, whatever its model choice (most tests exercise one engine). */
export function onlyEngine(stages: EngineStages): Engines {
  return { fake: stages, real: stages, for: () => stages };
}

/** The fake engine's choice, with no model client, for every run. */
export const FAKE_CHOICE: LlmChoice = { provider: "fake", model: "fake", reasoning: "default" };
export const noRunLlm: RunLlmFactory = { forRun: async () => ({ choice: FAKE_CHOICE, llm: null }), choiceOf: () => FAKE_CHOICE };

export interface WorkerHarness {
  tdb: TestDatabase;
  redis: Redis;
  queue: FakeQueue;
  /** Every run on `stages` with no model client, unless `overrides` sets `engines` / `runLlm`. */
  deps(stages: EngineStages, overrides?: Partial<WorkerDeps>): WorkerDeps;
  close(): Promise<void>;
}

export async function createHarness(): Promise<WorkerHarness> {
  const tdb = await createTestDatabase();
  const redis = new Redis(REDIS_URL);
  const watcher = new CancelWatcher(new Redis(REDIS_URL));
  const queue = new FakeQueue();
  return {
    tdb,
    redis,
    queue,
    deps: (stages, overrides = {}) => ({
      config: {
        secretsKey: SECRETS_KEY,
        analysisTimeoutSeconds: 120,
        surveyTimeoutSeconds: 180,
        heartbeatMs: 20,
        staleAfterMs: 60_000,
        confirmationTtlHours: 24,
        queuedStaleAfterMs: 10 * 60_000,
        deadlineGraceMs: 60_000,
        // maxRunSeconds 60 → 600 ms total; exploration budget 360 ms.
        timeScale: 0.01,
      },
      db: tdb.db,
      redis,
      cancelWatcher: watcher,
      queue,
      engines: onlyEngine(stages),
      runLlm: noRunLlm,
      logger: silentLogger,
      ...overrides,
    }),
    async close() {
      watcher.close();
      redis.disconnect();
      await tdb.drop();
    },
  };
}

export function request(overrides: Partial<StoredTestRunRequest["options"]> = {}, secretNames: string[] = []): StoredTestRunRequest {
  return {
    targetUrl: "https://shop.example.com",
    requirement: "A user can add a product to the cart. The cart count should increase.",
    environment: "staging",
    browser: "chromium",
    testData: {},
    secretNames,
    options: {
      maxExplorationSteps: 40,
      maxRunSeconds: 60,
      generatePlaywright: true,
      rerunGeneratedTest: true,
      autoConfirmCriteria: false,
      allowDestructiveActions: false,
      additionalAllowedHosts: [],
      ...overrides,
    },
  };
}

/** What seedRun stores for a run it walks to AWAITING_SELECTION (the survey's suggestions, in short). */
export const SEEDED_SUGGESTIONS: SuggestionSetDraft = {
  suggestions: [
    {
      id: "S-1",
      title: "Add a product to the cart",
      requirement: "A user can add iPhone 17 Pro to the cart from its product page.",
      why: "Product pages have an Add to cart button.",
      needs: { secrets: [], testData: [] },
      destructive: false,
    },
    {
      id: "S-2",
      title: "Sign in to the account",
      requirement: "A user can sign in on the login page with valid credentials and lands on their account page.",
      why: "The header links to a login page.",
      needs: { secrets: ["password"], testData: ["email"] },
      destructive: false,
    },
  ],
  pages: [{ url: "https://shop.example.com/", title: "Home · Demo Shop", status: "READ" }],
};

/**
 * Creates a run and walks it to `lifecycle` (PLANNING includes a confirmed requirement;
 * AWAITING_SELECTION stores SEEDED_SUGGESTIONS). `requirement: ""` makes a blank-requirement run.
 */
export async function seedRun(
  h: WorkerHarness,
  opts: {
    lifecycle?: RunLifecycle;
    options?: Partial<StoredTestRunRequest["options"]>;
    secrets?: Record<string, string>;
    /** The run's recorded model choice; unset, a run created before model choice (the environment's). */
    llm?: LlmChoice;
    requirement?: string;
    /** The run's target (the rerun's navigation guard allows its host); default https://shop.example.com. */
    targetUrl?: string;
    testData?: StoredTestRunRequest["testData"];
  } = {},
): Promise<TestRun> {
  const runs = new RunRepository(h.tdb.db);
  const secrets = opts.secrets ?? {};
  const stored = {
    ...request(opts.options, Object.keys(secrets)),
    ...(opts.targetUrl ? { targetUrl: opts.targetUrl } : {}),
    ...(opts.testData ? { testData: opts.testData } : {}),
  };
  const run = await runs.create({
    tenantId: TEST_TENANT_ID,
    targetUrl: stored.targetUrl,
    request: {
      ...(opts.requirement === undefined ? stored : { ...stored, requirement: opts.requirement }),
      ...(opts.llm ? { llm: opts.llm } : {}),
    },
  });
  await new SecretRepository(h.tdb.db).insertMany(
    run.id,
    Object.entries(secrets).map(([name, v]) => ({ name, ...encryptSecret(v, { runId: run.id, name }, SECRETS_KEY) })),
  );
  const target = opts.lifecycle ?? "QUEUED";
  if (target === "QUEUED") return run;
  if (target === "SURVEYING" || target === "AWAITING_SELECTION") {
    await runs.transition(run.id, "QUEUED", "SURVEYING", { heartbeatAt: new Date() });
    if (target === "SURVEYING") return runs.getById(run.id);
    await new SuggestionRepository(h.tdb.db).save(run.id, SEEDED_SUGGESTIONS);
    await runs.transition(run.id, "SURVEYING", "AWAITING_SELECTION", { heartbeatAt: null });
    return runs.getById(run.id);
  }
  await runs.transition(run.id, "QUEUED", "ANALYZING_REQUIREMENT", { heartbeatAt: new Date() });
  if (target === "ANALYZING_REQUIREMENT") return runs.getById(run.id);
  const stages = createFakeStages();
  const draft = await stages.analyze({ request: run.request } as never);
  const reqs = new RequirementRepository(h.tdb.db);
  await reqs.createRevision(run.id, draft);
  await runs.transition(run.id, "ANALYZING_REQUIREMENT", "AWAITING_CONFIRMATION");
  if (target === "AWAITING_CONFIRMATION") return runs.getById(run.id);
  await reqs.confirm(run.id, 1);
  await runs.transition(run.id, "AWAITING_CONFIRMATION", "PLANNING", { heartbeatAt: new Date() });
  return runs.getById(run.id);
}

export async function eventsOf(h: WorkerHarness, runId: string): Promise<TestEvent[]> {
  return new EventRepository(h.tdb.db).listAfter(runId, 0, 1000);
}

export async function requestCancel(h: WorkerHarness, runId: string, viaRedis = true): Promise<void> {
  await new RunRepository(h.tdb.db).requestCancel(runId, "USER_REQUESTED");
  if (viaRedis) await h.redis.publish(runCancelChannel(runId), "cancel");
}

export { createFakeStages, type FakeEngineOptions };

/** A value the fake page shows for `key@checkpoint`, and whether the DOM read confirms it. */
export interface FakeFactValue {
  value: FactValue;
  dom: boolean;
}

/**
 * A scripted stand-in for the sandbox + Stagehand explorer + recorder, so the real explore stage
 * runs without a browser: every observe finds one element (a search's submit button is a second one,
 * as on a real page), every click succeeds, extract answers
 * null for every requested fact. `facts` (keyed `key@checkpoint`) scripts what the page shows: a
 * `dom: true` value is confirmed by the DOM read (DOM_VERIFIED), otherwise it stays MODEL_EXTRACTED.
 */
export function fakeExploration(opts: { facts?: Record<string, FakeFactValue> } = {}): { deps: Partial<ExploreStageDeps>; log: string[] } {
  const log: string[] = [];
  let url = "about:blank";
  // A page that starts no requests: a click's are waited for through on/off (KI-049).
  const page = { url: () => url, isClosed: () => false, waitForLoadState: async () => {}, mainFrame: () => null, on: () => {}, off: () => {} } as unknown as Page;
  const session: ExplorerSession = {
    page,
    async navigate(u) {
      log.push(`navigate ${u}`);
      url = u;
      return { url };
    },
    async observe(instruction) {
      log.push("observe");
      const selector = /submits this search/.test(instruction) ? "xpath=/html[1]/body[1]/button[2]" : "xpath=/html[1]/body[1]/button[1]";
      return { elements: [{ selector, description: instruction.slice(0, 40), method: "click", arguments: [] }], llm: null };
    },
    async act() {
      throw new Error("the executor never lets the model act");
    },
    async actOn(element) {
      log.push(`actOn ${element.method}`);
      return { success: true, message: "ok", element, navigationBlocks: [], llm: null };
    },
    async extract(_instruction, schema) {
      log.push("extract");
      const shape = (schema as unknown as { shape: Record<string, unknown> }).shape;
      return { data: schema.parse(Object.fromEntries(Object.keys(shape).map((k) => [k, null]))), llm: null };
    },
    async screenshot() {
      return Buffer.from("\x89PNG fake");
    },
    async close() {
      log.push("session.close");
    },
  };
  const ref = { candidates: [{ strategy: "xpath" as const, selector: "/html[1]/body[1]/button[1]" }], chosenIndex: 0, framePath: [] };
  const recorder: RecorderPort = {
    // No role: this page answers every lookup, fields included, with the same element.
    describe: async () => ({ role: null, name: "Continue", text: "Continue" }),
    record: async () => ref,
    fill: async () => void log.push("fill"),
    select: async () => void log.push("select"),
    captureFact: async (_page, input) => {
      const scripted = opts.facts?.[`${input.key}@${input.checkpoint}`];
      if (!scripted) return factFromReadings({ ...input, dom: null });
      const dom = scripted.dom ? { value: scripted.value, read: { element: input.element ?? ref, mode: input.mode ?? "text" } } : null;
      return factFromReadings({ ...input, modelValue: scripted.value, dom });
    },
  };
  return {
    log,
    deps: {
      openSandbox: async () => ({
        cdpUrl: "http://127.0.0.1:9",
        extensionIds: ["stagehand"],
        page,
        close: async () => void log.push("sandbox.close"),
      }),
      explorer: { start: async () => session },
      recorder,
      // A browserless page cannot be recorded (V1.3 recordings are covered by sandbox/session-recording.test.ts).
      startRecording: async () => null,
    },
  };
}
