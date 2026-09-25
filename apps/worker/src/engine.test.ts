import { LlmCallRepository, PlanRepository, RequirementRepository, ResultRepository, RunRepository } from "@platform/db";
import { FakeTransport } from "@platform/llm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { silentLogger } from "./deps";
import { createEngine } from "./engine";
import { analyzeRunJob } from "./jobs/analyze-run";
import { executeRunJob } from "./jobs/execute-run";
import { createHarness, eventsOf, seedRun, type WorkerHarness } from "./test-support";

let h: WorkerHarness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => h?.close());

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
    const engine = createEngine(
      { LLM_PROVIDER: "anthropic", LLM_MODEL: "claude-sonnet-5", ANTHROPIC_API_KEY: "sk-test" },
      { db: h.tdb.db, logger: silentLogger, transport },
    );
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
    const engine = createEngine(
      { LLM_PROVIDER: "anthropic", LLM_MODEL: "claude-sonnet-5", ANTHROPIC_API_KEY: "sk-test" },
      { db: h.tdb.db, logger: silentLogger, transport },
    );
    const run = await seedRun(h, { lifecycle: "PLANNING", secrets: { password: "pw-Plan-Secret-456" } });

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

  it("real engine: explore/verify stay fake for now, generateTest is the R7 null stub", async () => {
    const engine = createEngine(
      { LLM_PROVIDER: "anthropic", LLM_MODEL: "claude-sonnet-5", ANTHROPIC_API_KEY: "sk-test" },
      { db: h.tdb.db, logger: silentLogger, transport: new FakeTransport() },
    );
    expect(await engine.stages.generateTest({} as never, {} as never)).toBeNull();
  });

  it("real engine never reports PASS/FAIL from stages that are still fake (no PASS without evidence)", async () => {
    const engine = createEngine(
      { LLM_PROVIDER: "anthropic", LLM_MODEL: "claude-sonnet-5", ANTHROPIC_API_KEY: "sk-test" },
      // Even a fallback configured to PASS must not leak a verdict into a real run.
      {
        db: h.tdb.db,
        logger: silentLogger,
        transport: new FakeTransport().enqueue({ json: planned }),
        fake: { provisionalStatus: "PASS" },
      },
    );
    const run = await seedRun(h, { lifecycle: "PLANNING" });

    await executeRunJob(h.deps(engine.stages), run.id);

    const after = await new RunRepository(h.tdb.db).getById(run.id);
    expect(after.lifecycle).toBe("COMPLETED");
    expect(after.verdict).toBe("INCONCLUSIVE");
    const results = await new ResultRepository(h.tdb.db).listByRun(run.id);
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) expect(r).toMatchObject({ status: "INCONCLUSIVE", reason: "FACT_NOT_OBSERVED" });
  });
});
