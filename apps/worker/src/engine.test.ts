import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ArtifactRepository,
  ExplorationStepRepository,
  LlmCallRepository,
  ObservedFactRepository,
  PlanRepository,
  RequirementRepository,
  ResultRepository,
  RunRepository,
} from "@platform/db";
import { FakeTransport } from "@platform/llm";
import { createLocalStorage } from "@platform/storage";
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
/** Real-engine deps with a browserless sandbox/explorer (the real one is covered by tests/integration). */
const realDeps = (transport: FakeTransport, extra: Record<string, unknown> = {}) => {
  const exploration = fakeExploration();
  return {
    exploration,
    deps: { db: h.tdb.db, logger: silentLogger, transport, storage: createLocalStorage({ rootDir: artifactDir }), exploration: exploration.deps, ...extra },
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
    const transport = new FakeTransport().enqueue({ json: planned, usage: { inputTokens: 2000, outputTokens: 500 } });
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
    expect(calls).toMatchObject([{ stage: "PLANNING", inputTokens: 2000, outputTokens: 500, status: "SUCCESS" }]);

    const sent = JSON.stringify(transport.requests.map(({ signal: _s, ...r }) => r));
    expect(sent).toContain("password");
    expect(sent).not.toContain("pw-Plan-Secret-456");
    expect(JSON.stringify(plan)).not.toContain("pw-Plan-Secret-456");
  });

  it("real engine: generateTest is the R7 null stub", async () => {
    const engine = createEngine(REAL, realDeps(new FakeTransport()).deps);
    expect(await engine.stages.generateTest({} as never, {} as never)).toBeNull();
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

  it("real engine never reports PASS/FAIL from stages that are still fake (no PASS without evidence)", async () => {
    // Even a fallback configured to PASS must not leak a verdict into a real run.
    const engine = createEngine(REAL, realDeps(new FakeTransport().enqueue({ json: planned }), { fake: { provisionalStatus: "PASS" } }).deps);
    const run = await seedRun(h, { lifecycle: "PLANNING", options: { maxRunSeconds: 600 } });

    await executeRunJob(h.deps(engine.stages), run.id);

    const after = await new RunRepository(h.tdb.db).getById(run.id);
    expect(after.lifecycle).toBe("COMPLETED");
    expect(after.verdict).toBe("INCONCLUSIVE");
    const results = await new ResultRepository(h.tdb.db).listByRun(run.id);
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) expect(r).toMatchObject({ status: "INCONCLUSIVE", reason: "FACT_NOT_OBSERVED" });
  });
});
