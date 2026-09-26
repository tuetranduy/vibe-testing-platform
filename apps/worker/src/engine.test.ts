import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CriterionResult } from "@platform/contracts";
import {
  ArtifactRepository,
  DiagnosticFindingRepository,
  ExplorationStepRepository,
  GeneratedTestRepository,
  LlmCallRepository,
  ObservedFactRepository,
  PlanRepository,
  RequirementRepository,
  ResultRepository,
  RunRepository,
} from "@platform/db";
import { FakeTransport } from "@platform/llm";
import { createLocalStorage } from "@platform/storage";
import type { RunnerProcessInput, SpawnRunner } from "@platform/testing-engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { silentLogger } from "./deps";
import { createEngine } from "./engine";
import { analyzeRunJob } from "./jobs/analyze-run";
import { executeRunJob } from "./jobs/execute-run";
import { createHarness, eventsOf, fakeExploration, seedRun, type WorkerHarness } from "./test-support";

let h: WorkerHarness;
let artifactDir: string;
beforeAll(async () => {
  h = await createHarness();
  artifactDir = mkdtempSync(path.join(os.tmpdir(), "worker-engine-artifacts-"));
});
afterAll(async () => {
  await h?.close();
  if (artifactDir) rmSync(artifactDir, { recursive: true, force: true });
});

const REAL = { LLM_PROVIDER: "anthropic", LLM_MODEL: "claude-sonnet-5", ANTHROPIC_API_KEY: "sk-test" } as const;
/**
 * A browserless rerun child (the real one is covered by sandbox/runner-process.test.ts): every
 * compiled `[AC-n]` step of the workspace's run.spec.ts passes, except the `failing` ones, whose
 * assertion fails.
 */
function fakeRerunSpawn(failing: string[] = []): SpawnRunner & { calls: RunnerProcessInput[] } {
  const calls: RunnerProcessInput[] = [];
  const spawn = (async (input: RunnerProcessInput) => {
    calls.push(input);
    const source = readFileSync(path.join(input.cwd, "run.spec.ts"), "utf8");
    const ids = [...source.matchAll(/test\.step\("\[(AC-\d+)\] "/g)].map((m) => m[1]!);
    const error = { message: "Error: expect(received).toBeGreaterThan(expected)\n\nExpected: > 1\nReceived:   1" };
    // Playwright stops at the first failed assertion: later steps never start (NOT_REACHED).
    const firstFailure = ids.findIndex((id) => failing.includes(id));
    const ran = firstFailure === -1 ? ids : ids.slice(0, firstFailure + 1);
    const steps = ran.map((id) => ({ title: `[${id}] statement`, duration: 1, ...(failing.includes(id) ? { error } : {}) }));
    const status = firstFailure === -1 ? "passed" : "failed";
    const results = { suites: [{ specs: [{ tests: [{ results: [{ status, errors: [], steps, attachments: [] }] }] }] }], errors: [] };
    writeFileSync(path.join(input.cwd, "results.json"), JSON.stringify(results));
    return { exitCode: 0, signal: null };
  }) as SpawnRunner & { calls: RunnerProcessInput[] };
  spawn.calls = calls;
  return spawn;
}

/** Real-engine deps with a browserless sandbox/explorer (the real one is covered by tests/integration) and rerun child. */
const realDeps = (
  transport: FakeTransport,
  extra: Record<string, unknown> = {},
  page: Parameters<typeof fakeExploration>[0] = {},
  failingInRerun: string[] = [],
) => {
  const exploration = fakeExploration(page);
  const rerunSpawn = fakeRerunSpawn(failingInRerun);
  const rerunDir = path.join(artifactDir, "runs");
  return {
    exploration,
    rerunSpawn,
    rerunDir,
    deps: {
      db: h.tdb.db,
      logger: silentLogger,
      transport,
      storage: createLocalStorage({ rootDir: artifactDir }),
      exploration: exploration.deps,
      rerun: { spawn: rerunSpawn, workspace: { baseDir: rerunDir } },
      ...extra,
    },
  };
};

const compiled = {
  criteria: [
    {
      sourceText: "The cart count should increase.",
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
  ],
  facts: [
    { key: "cartCount", checkpoint: "before_add", description: "Cart badge count", valueType: "number" },
    { key: "cartCount", checkpoint: "after_add", description: "Cart badge count", valueType: "number" },
  ],
};

/** Planner reply for the requirement seedRun confirms (fake analyze: before_add/after_add/cart_page). */
const planStep = (kind: string, description: string, extra: Record<string, unknown> = {}) => ({
  kind,
  description,
  inputRef: null,
  checkpoint: null,
  criterionIds: [],
  destructive: false,
  ...extra,
});
const planned = {
  title: "Add a product to the cart",
  steps: [
    planStep("navigate", "Open the shop home page"),
    planStep("search", "Search for the product", { inputRef: { source: "literal", key: "iPhone 17 Pro" } }),
    planStep("capture_checkpoint", "Capture the cart badge before adding", { checkpoint: "before_add" }),
    planStep("click", "Click Add to cart", { criterionIds: ["AC-1"] }),
    planStep("capture_checkpoint", "Capture the cart badge after adding", { checkpoint: "after_add" }),
    planStep("click", "Open the cart"),
    planStep("capture_checkpoint", "Capture the cart contents", { checkpoint: "cart_page" }),
  ],
  stopConditions: [],
};

/** The report's diagnostics reply (Task 18): nothing to add. */
const noDiagnostics = { json: { findings: [], notes: [] } };

describe("createEngine (Ruling R7)", () => {
  it("LLM_PROVIDER=fake keeps the full fake engine", async () => {
    const engine = createEngine({ LLM_PROVIDER: "fake", LLM_MODEL: "claude-sonnet-5" }, { db: h.tdb.db, logger: silentLogger });
    expect(engine.kind).toBe("fake");
    expect(engine.llm).toBeNull();
  });

  it("LLM_PROVIDER=openai fails fast at startup", () => {
    expect(() =>
      createEngine({ LLM_PROVIDER: "openai", LLM_MODEL: "gpt-x", OPENAI_API_KEY: "k" }, { db: h.tdb.db, logger: silentLogger }),
    ).toThrow(/not implemented in V1/);
  });

  it("a real provider compiles criteria with the LLM, persists revision 1, and records llm_calls rows", async () => {
    const transport = new FakeTransport().enqueue({ json: compiled, usage: { inputTokens: 1200, outputTokens: 300 } });
    const engine = createEngine(REAL, realDeps(transport).deps);
    expect(engine.kind).toBe("real");
    const run = await seedRun(h, { secrets: { password: "pw-Top-Secret-123" } });

    await analyzeRunJob(h.deps(engine.stages), run.id);

    expect((await new RunRepository(h.tdb.db).getById(run.id)).lifecycle).toBe("AWAITING_CONFIRMATION");
    const req = await new RequirementRepository(h.tdb.db).getLatest(run.id);
    expect(req.revision).toBe(1);
    expect(req.criteria.map((c) => [c.id, c.statement])).toEqual([["AC-1", "The cart count increases after adding a product"]]);
    const proposed = (await eventsOf(h, run.id)).find((e) => e.type === "criteria.proposed")!;
    expect(proposed.message).toBe("1 acceptance criterion identified");

    const calls = await new LlmCallRepository(h.tdb.db).listByRun(run.id);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      stage: "ANALYZING_REQUIREMENT",
      provider: "fake",
      model: "claude-sonnet-5",
      inputTokens: 1200,
      outputTokens: 300,
      estimatedCostUsd: 0.0054,
      status: "SUCCESS",
    });

    // Secret names reach the prompt; values never do.
    const sent = JSON.stringify(transport.requests.map(({ signal: _s, ...r }) => r));
    expect(sent).toContain("password");
    expect(sent).not.toContain("pw-Top-Secret-123");
  });

  it("real engine plans with the LLM: plan persisted, plan.created published, PLANNING llm_calls row, no secret sent", async () => {
    const transport = new FakeTransport().enqueue({ json: planned, usage: { inputTokens: 2000, outputTokens: 500 } }, noDiagnostics);
    const engine = createEngine(REAL, realDeps(transport).deps);
    const run = await seedRun(h, { lifecycle: "PLANNING", options: { maxRunSeconds: 600 }, secrets: { password: "pw-Plan-Secret-456" } });

    await executeRunJob(h.deps(engine.stages), run.id);

    const plan = (await new PlanRepository(h.tdb.db).find(run.id))!;
    expect(plan.scenarios[0]!.criterionIds).toEqual(["AC-1", "AC-2"]);
    expect(plan.scenarios[0]!.steps.filter((s) => s.kind === "capture_checkpoint").map((s) => s.checkpoint)).toEqual([
      "before_add",
      "after_add",
      "cart_page",
    ]);
    expect(plan.blockedCriteria).toEqual([]);
    const created = (await eventsOf(h, run.id)).find((e) => e.type === "plan.created")!;
    expect(created.message).toBe("Plan created with 7 steps");

    const calls = await new LlmCallRepository(h.tdb.db).listByRun(run.id);
    expect(calls).toMatchObject([
      { stage: "PLANNING", inputTokens: 2000, outputTokens: 500, status: "SUCCESS" },
      { stage: "GENERATING_REPORT", status: "SUCCESS" }, // report diagnostics (nothing passed here)
    ]);

    const sent = JSON.stringify(transport.requests.map(({ signal: _s, ...r }) => r));
    expect(sent).toContain("password");
    expect(sent).not.toContain("pw-Plan-Secret-456");
    expect(JSON.stringify(plan)).not.toContain("pw-Plan-Secret-456");
  });

  it("real engine generates the Playwright test (Task 16), reruns it in the sandbox (Task 17) and reconciles the outcome (Task 18)", async () => {
    const page = {
      facts: {
        "cartCount@before_add": { value: 0, dom: true },
        "cartCount@after_add": { value: 1, dom: true },
        "cartItems@cart_page": { value: ["iPhone 17 Pro"], dom: false },
      },
    };
    const real = realDeps(new FakeTransport().enqueue({ json: planned }, noDiagnostics), {}, page);
    const engine = createEngine(REAL, real.deps);
    const run = await seedRun(h, { lifecycle: "PLANNING", options: { maxRunSeconds: 600 } });

    await executeRunJob(h.deps(engine.stages), run.id);

    const test = (await new GeneratedTestRepository(h.tdb.db).findByRun(run.id))!;
    expect(test.id).toMatch(/^gt_/);
    expect(test.compiledCriteria).toEqual(["AC-1"]);
    expect(test.notCompiled).toEqual([{ criterionId: "AC-2", reason: "Fact cartItems@cart_page was extracted by the model, not read from the page" }]);
    expect(test.source).toContain("await page.goto(data.targetUrl);");
    expect(test.source).not.toContain("iPhone");
    expect(JSON.parse(test.dataJson).inputs).toEqual({ input1: "iPhone 17 Pro" });

    const events = await eventsOf(h, run.id);
    expect(events.filter((e) => e.type === "test.generated").map((e) => e.payload)).toEqual([
      { compiledCriteria: ["AC-1"], notCompiled: test.notCompiled },
    ]);
    // The rerun ran the persisted test in its own workspace, behind the rerun proxy, and was cleaned up.
    expect(real.rerunSpawn.calls).toHaveLength(1);
    expect(real.rerunSpawn.calls[0]!.cwd).toBe(path.join(real.rerunDir, run.id));
    expect(existsSync(path.join(real.rerunDir, run.id))).toBe(false);
    const completed = events.filter((e) => e.type === "playwright.completed");
    expect(completed).toHaveLength(1); // published by the orchestrator only (R34)
    // Each criterion's rerun outcome is persisted with it, for partial reports (Ruling R43).
    expect(completed[0]!.payload).toEqual({ status: "PASSED", durationMs: expect.any(Number), perCriterion: { "AC-1": "PASSED" } });
    // The rerun confirmed the compiled criterion; the one it could not compile rests on unverified evidence.
    const results = await new ResultRepository(h.tdb.db).listByRun(run.id);
    expect(results.find((r) => r.criterionId === "AC-1")).toMatchObject({ status: "PASS", verdictSource: "PLAYWRIGHT_RERUN", rerunOutcome: "PASSED" });
    expect(results.find((r) => r.criterionId === "AC-2")).toMatchObject({ status: "INCONCLUSIVE", reason: "UNVERIFIED_EVIDENCE", rerunOutcome: "UNAVAILABLE" });
    expect((await new RunRepository(h.tdb.db).findById(run.id))!.lifecycle).toBe("COMPLETED");
  });

  it("the real engine needs artifact storage (fails fast at startup)", () => {
    expect(() => createEngine(REAL, { db: h.tdb.db, logger: silentLogger, transport: new FakeTransport() })).toThrow(/artifact storage/);
  });

  it("real engine explores (Task 14): steps, facts and screenshots persisted; sandbox and session released", async () => {
    const { deps, exploration } = realDeps(new FakeTransport().enqueue({ json: planned }));
    const engine = createEngine(REAL, deps);
    const run = await seedRun(h, { lifecycle: "PLANNING", options: { maxRunSeconds: 600 }, secrets: { password: "pw-Explore-789" } });

    await executeRunJob(h.deps(engine.stages), run.id);

    expect((await new RunRepository(h.tdb.db).getById(run.id)).lifecycle).toBe("COMPLETED");
    const steps = await new ExplorationStepRepository(h.tdb.db).listByRun(run.id);
    expect(steps.map((s) => s.index)).toEqual(steps.map((_, i) => i));
    // The planned flow ran end to end: 3 checkpoints recorded on the golden path.
    expect(steps.filter((s) => s.kind === "checkpoint" && s.onGoldenPath).length).toBe(3);
    expect(steps.find((s) => s.kind === "fill")).toMatchObject({ plannedStepId: "PS-2", inputRef: { source: "literal", key: "iPhone 17 Pro" }, onGoldenPath: true });
    const facts = await new ObservedFactRepository(h.tdb.db).listByRun(run.id);
    expect(facts.filter((f) => f.key === "url").map((f) => f.checkpoint).sort()).toEqual(["after_add", "before_add", "cart_page"]);
    expect(facts.find((f) => f.key === "cartCount")).toMatchObject({ provenance: "MODEL_EXTRACTED", value: null });
    const artifacts = await new ArtifactRepository(h.tdb.db).listByRun(run.id);
    expect(artifacts).toHaveLength(3);
    expect(artifacts.every((a) => a.type === "SCREENSHOT" && a.sensitivity === "SECRET_BEARING")).toBe(true);

    const events = await eventsOf(h, run.id);
    expect(events.filter((e) => e.type === "step.recorded")).toHaveLength(steps.length);
    expect(events.filter((e) => e.type === "fact.observed")).toHaveLength(facts.length);
    expect(events.filter((e) => e.type === "artifact.created").map((e) => e.payload)).toEqual(
      artifacts.map((a) => ({ artifactId: a.id, type: "SCREENSHOT", sensitivity: "SECRET_BEARING" })),
    );
    expect(events.every((e) => e.stage !== "EXPLORING" || ["stage.started", "step.recorded", "fact.observed", "artifact.created", "stage.completed"].includes(e.type))).toBe(true);
    expect(exploration.log).toContain("sandbox.close");
    expect(exploration.log).toContain("session.close");
    expect(exploration.log.filter((l) => l.startsWith("actOn")).every((l) => l === "actOn click")).toBe(true);
  });

  it("real engine: a sandbox that fails to launch ends the run ERRORED / BROWSER_PROVIDER with a clean message; Chromium's stderr stays in the worker log", async () => {
    const stderr = "Chromium exited during launch: No usable sandbox! ... you can try using --no-sandbox.";
    const logged: { level: string; obj: object; msg?: string }[] = [];
    const at = (level: string) => (obj: object, msg?: string) => void logged.push({ level, obj, msg });
    const logger = { info: at("info"), warn: at("warn"), error: at("error") };
    const { deps, exploration } = realDeps(new FakeTransport().enqueue({ json: planned }), { logger });
    deps.exploration = {
      ...exploration.deps,
      openSandbox: async () => {
        throw new Error(stderr);
      },
    };
    const engine = createEngine(REAL, deps);
    const run = await seedRun(h, { lifecycle: "PLANNING", options: { maxRunSeconds: 600 } });

    await executeRunJob(h.deps(engine.stages), run.id);

    const after = await new RunRepository(h.tdb.db).getById(run.id);
    expect([after.lifecycle, after.errorCategory, after.errorMessage]).toEqual(["ERRORED", "BROWSER_PROVIDER", "Browser sandbox failed to start"]);
    const events = await eventsOf(h, run.id);
    expect(events.find((e) => e.type === "run.errored")?.payload).toEqual({ category: "BROWSER_PROVIDER", message: "Browser sandbox failed to start" });
    expect(JSON.stringify(events)).not.toContain("no-sandbox");
    const sandboxLog = logged.find((l) => l.msg === "browser sandbox failed to start");
    expect(sandboxLog).toMatchObject({ level: "error", obj: { runId: run.id } });
    expect(((sandboxLog!.obj as { err: Error }).err).message).toContain("--no-sandbox");
  });

  it("real engine verifies from recorded facts: nothing observed → INCONCLUSIVE / FACT_NOT_OBSERVED (a fallback set to PASS has no say)", async () => {
    // The fake page shows nothing (extract answers null): no criterion can be decided.
    const engine = createEngine(REAL, realDeps(new FakeTransport().enqueue({ json: planned }), { fake: { provisionalStatus: "PASS" } }).deps);
    const run = await seedRun(h, { lifecycle: "PLANNING", options: { maxRunSeconds: 600 } });

    await executeRunJob(h.deps(engine.stages), run.id);

    const after = await new RunRepository(h.tdb.db).getById(run.id);
    expect(after.lifecycle).toBe("COMPLETED");
    expect(after.verdict).toBe("INCONCLUSIVE");
    const results = await new ResultRepository(h.tdb.db).listByRun(run.id);
    expect(results.map((r) => r.criterionId).sort()).toEqual(["AC-1", "AC-2"]);
    for (const r of results) expect(r).toMatchObject({ status: "INCONCLUSIVE", reason: "FACT_NOT_OBSERVED" });
  });

  it("real engine end to end: a DOM_VERIFIED cart delta is a provisional PASS the rerun confirms; MODEL_EXTRACTED evidence ends UNVERIFIED_EVIDENCE", async () => {
    const page = {
      facts: {
        "cartCount@before_add": { value: 0, dom: true },
        "cartCount@after_add": { value: 1, dom: true },
        // The model says the cart lists the product, but the DOM read did not confirm it.
        "cartItems@cart_page": { value: ["iPhone 17 Pro"], dom: false },
      },
    };
    const engine = createEngine(REAL, realDeps(new FakeTransport().enqueue({ json: planned }, noDiagnostics), {}, page).deps);
    const run = await seedRun(h, { lifecycle: "PLANNING", options: { maxRunSeconds: 600 } });

    await executeRunJob(h.deps(engine.stages), run.id);

    const facts = await new ObservedFactRepository(h.tdb.db).listByRun(run.id);
    expect(facts.filter((f) => f.key !== "url").map((f) => [f.key, f.checkpoint, f.value, f.provenance])).toEqual(
      expect.arrayContaining([
        ["cartCount", "before_add", 0, "DOM_VERIFIED"],
        ["cartCount", "after_add", 1, "DOM_VERIFIED"],
        ["cartItems", "cart_page", ["iPhone 17 Pro"], "MODEL_EXTRACTED"],
      ]),
    );

    // Provisional results are published during VERIFYING, built from the recorded facts.
    const events = await eventsOf(h, run.id);
    const provisional = events.filter((e) => e.type === "criterion.evaluated" && e.stage === "VERIFYING").map((e) => e.payload);
    expect(provisional).toEqual([
      { criterionId: "AC-1", status: "PASS", reason: null, provisional: true },
      { criterionId: "AC-2", status: "PASS", reason: null, provisional: true },
    ]);
    expect(events.find((e) => e.type === "criterion.evaluated" && e.stage === "VERIFYING")!.message).toBe("AC-1 provisionally PASS");

    // Final results (Section 2.3): the rerun confirms AC-1; AC-2 was not compiled and its evidence is not deterministic.
    const results = await new ResultRepository(h.tdb.db).listByRun(run.id);
    const byId = Object.fromEntries(results.map((r) => [r.criterionId, r]));
    expect(byId["AC-1"]).toMatchObject({
      status: "PASS",
      reason: null,
      verdictSource: "PLAYWRIGHT_RERUN",
      rerunOutcome: "PASSED",
      factRefs: [
        { key: "cartCount", checkpoint: "after_add" },
        { key: "cartCount", checkpoint: "before_add" },
      ],
      expected: "Cart count after add > before add",
      actual: "Cart count after add (1) > before add (0)",
      provisional: { status: "PASS", reason: null },
    });
    expect(byId["AC-2"]).toMatchObject({
      status: "INCONCLUSIVE",
      reason: "UNVERIFIED_EVIDENCE",
      verdictSource: null,
      rerunOutcome: "UNAVAILABLE",
      provisional: { status: "PASS", reason: null },
    });
    const final = events.filter((e) => e.type === "criterion.evaluated" && e.stage === "GENERATING_REPORT").map((e) => e.payload);
    expect(final).toEqual([
      { criterionId: "AC-1", status: "PASS", reason: null, provisional: false },
      { criterionId: "AC-2", status: "INCONCLUSIVE", reason: "UNVERIFIED_EVIDENCE", provisional: false },
    ]);
    expect((await new RunRepository(h.tdb.db).getById(run.id)).verdict).toBe("INCONCLUSIVE");
  });

  it("real engine end to end: every criterion backed by DOM_VERIFIED facts → verdict PASSED", async () => {
    const page = {
      facts: {
        "cartCount@before_add": { value: 0, dom: true },
        "cartCount@after_add": { value: 1, dom: true },
        "cartItems@cart_page": { value: ["Apple iPhone 17 Pro"], dom: true },
      },
    };
    const engine = createEngine(REAL, realDeps(new FakeTransport().enqueue({ json: planned }), {}, page).deps);
    const run = await seedRun(h, { lifecycle: "PLANNING", options: { maxRunSeconds: 600 } });

    await executeRunJob(h.deps(engine.stages), run.id);

    const after = await new RunRepository(h.tdb.db).getById(run.id);
    expect([after.lifecycle, after.verdict]).toEqual(["COMPLETED", "PASSED"]);
    const results = await new ResultRepository(h.tdb.db).listByRun(run.id);
    for (const r of results) expect(r).toMatchObject({ status: "PASS", verdictSource: "PLAYWRIGHT_RERUN", rerunOutcome: "PASSED" });
    // Nothing to diagnose: no model call in GENERATING_REPORT.
    expect((await new LlmCallRepository(h.tdb.db).listByRun(run.id)).map((c) => c.stage)).toEqual(["PLANNING"]);
  });

  it("real engine with the rerun disabled: a DOM-backed PASS stands as EXPLORATION_ONLY (not confirmed by rerun)", async () => {
    const page = {
      facts: {
        "cartCount@before_add": { value: 0, dom: true },
        "cartCount@after_add": { value: 1, dom: true },
        "cartItems@cart_page": { value: ["Apple iPhone 17 Pro"], dom: true },
      },
    };
    const real = realDeps(new FakeTransport().enqueue({ json: planned }), {}, page);
    const engine = createEngine(REAL, real.deps);
    const run = await seedRun(h, { lifecycle: "PLANNING", options: { maxRunSeconds: 600, rerunGeneratedTest: false } });

    await executeRunJob(h.deps(engine.stages), run.id);

    expect(real.rerunSpawn.calls).toHaveLength(0);
    expect((await new RunRepository(h.tdb.db).getById(run.id)).verdict).toBe("PASSED");
    const results = await new ResultRepository(h.tdb.db).listByRun(run.id);
    for (const r of results) expect(r).toMatchObject({ status: "PASS", verdictSource: "EXPLORATION_ONLY", rerunOutcome: "UNAVAILABLE" });
  });

  it("real engine: a DOM_VERIFIED count that did not increase is a FAIL the rerun confirms; the failure keeps its evidence; diagnostics add a finding, never a status", async () => {
    const page = {
      facts: {
        "cartCount@before_add": { value: 1, dom: true },
        "cartCount@after_add": { value: 1, dom: true },
        "cartItems@cart_page": { value: [], dom: true },
      },
    };
    const finding = { criterionId: "AC-1", summary: "The cart badge stayed at 1: the Add to cart click may not have registered." };
    const transport = new FakeTransport().enqueue({ json: planned }, { json: { findings: [finding], notes: [] }, usage: { inputTokens: 900, outputTokens: 60 } });
    const engine = createEngine(REAL, realDeps(transport, {}, page, ["AC-1"]).deps);
    const run = await seedRun(h, { lifecycle: "PLANNING", options: { maxRunSeconds: 600 }, secrets: { password: "pw-Report-Secret-1" } });

    await executeRunJob(h.deps(engine.stages), run.id);

    expect((await new RunRepository(h.tdb.db).getById(run.id)).verdict).toBe("FAILED");
    const results = (await new ResultRepository(h.tdb.db).listByRun(run.id)) as CriterionResult[];
    const failed = results.find((r) => r.criterionId === "AC-1")!;
    expect(failed).toMatchObject({ status: "FAIL", verdictSource: "PLAYWRIGHT_RERUN", rerunOutcome: "ASSERTION_FAILED" });
    expect(failed.actual).toMatch(/^Cart count after add \(1\) is not > before add \(1\) \| Rerun: Error: expect\(received\)\.toBeGreaterThan/);
    // Playwright stopped at AC-1: AC-2 was not reached, so its DOM-backed FAIL stands on exploration alone.
    expect(results.find((r) => r.criterionId === "AC-2")).toMatchObject({ status: "FAIL", verdictSource: "EXPLORATION_ONLY", rerunOutcome: "NOT_REACHED" });
    // Failed criteria keep evidence: their steps' screenshots (the related steps recorded its facts).
    const screenshots = (await new ArtifactRepository(h.tdb.db).listByRun(run.id)).map((a) => a.id);
    expect(failed.relatedStepIds.length).toBeGreaterThan(0);
    expect(failed.evidenceArtifactIds.length).toBeGreaterThan(0);
    for (const id of failed.evidenceArtifactIds) expect(screenshots).toContain(id);

    expect(await new DiagnosticFindingRepository(h.tdb.db).listByRun(run.id)).toEqual([finding]);
    const calls = await new LlmCallRepository(h.tdb.db).listByRun(run.id);
    expect(calls.map((c) => [c.stage, c.status])).toEqual([["PLANNING", "SUCCESS"], ["GENERATING_REPORT", "SUCCESS"]]);
    const diagnosticsPrompt = JSON.stringify(transport.requests[1]!.messages);
    expect(diagnosticsPrompt).toContain("Run verdict: FAILED");
    expect(diagnosticsPrompt).not.toContain("pw-Report-Secret-1");
  });

  it("real engine: a diagnostics failure never fails the run — same statuses, no findings, a warning", async () => {
    const page = {
      facts: {
        "cartCount@before_add": { value: 1, dom: true },
        "cartCount@after_add": { value: 1, dom: true },
        "cartItems@cart_page": { value: [], dom: true },
      },
    };
    const warnings: string[] = [];
    const logger = { ...silentLogger, warn: (_obj: object, msg?: string) => void warnings.push(msg ?? "") };
    // No diagnostics reply scripted: the provider call fails.
    const engine = createEngine(REAL, realDeps(new FakeTransport().enqueue({ json: planned }), { logger }, page, ["AC-1"]).deps);
    const run = await seedRun(h, { lifecycle: "PLANNING", options: { maxRunSeconds: 600 } });

    await executeRunJob(h.deps(engine.stages), run.id);

    const after = await new RunRepository(h.tdb.db).getById(run.id);
    expect([after.lifecycle, after.verdict]).toEqual(["COMPLETED", "FAILED"]);
    const results = await new ResultRepository(h.tdb.db).listByRun(run.id);
    expect(results.map((r) => [r.criterionId, r.status]).sort()).toEqual([["AC-1", "FAIL"], ["AC-2", "FAIL"]]);
    expect(await new DiagnosticFindingRepository(h.tdb.db).listByRun(run.id)).toEqual([]);
    expect(warnings).toContain("report diagnostics failed; reporting without them");
  });
});
