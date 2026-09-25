import { LlmCallRepository, RequirementRepository, RunRepository } from "@platform/db";
import { FakeTransport } from "@platform/llm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { silentLogger } from "./deps";
import { createEngine } from "./engine";
import { analyzeRunJob } from "./jobs/analyze-run";
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

  it("real engine: plan/explore/verify stay fake for now, generateTest is the R7 null stub", async () => {
    const engine = createEngine(
      { LLM_PROVIDER: "anthropic", LLM_MODEL: "claude-sonnet-5", ANTHROPIC_API_KEY: "sk-test" },
      { db: h.tdb.db, logger: silentLogger, transport: new FakeTransport() },
    );
    expect(await engine.stages.generateTest({} as never, {} as never)).toBeNull();
  });
});
