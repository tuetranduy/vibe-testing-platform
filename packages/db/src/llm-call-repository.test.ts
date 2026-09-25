import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LlmCallRepository } from "./llm-call-repository";
import { RunRepository } from "./run-repository";
import { storedRequest } from "./test-helpers";
import { TEST_TENANT_ID, createTestDatabase, type TestDatabase } from "./testing";

let tdb: TestDatabase;
beforeAll(async () => {
  tdb = await createTestDatabase();
});
afterAll(async () => tdb?.drop());

describe("LlmCallRepository", () => {
  it("records calls and lists them per run in insertion order", async () => {
    const run = await new RunRepository(tdb.db).create({ tenantId: TEST_TENANT_ID, targetUrl: "https://x.com", request: storedRequest() });
    const repo = new LlmCallRepository(tdb.db);
    const base = {
      runId: run.id,
      stage: "ANALYZING_REQUIREMENT" as const,
      provider: "anthropic",
      model: "claude-sonnet-5",
      inputTokens: 1000,
      outputTokens: 500,
      estimatedCostUsd: 0.007,
      latencyMs: 812,
    };
    await repo.create({ ...base, status: "INVALID_OUTPUT" });
    await repo.create({ ...base, status: "SUCCESS" });

    const rows = await repo.listByRun(run.id);
    expect(rows.map((r) => r.status)).toEqual(["INVALID_OUTPUT", "SUCCESS"]);
    expect(rows[0]).toMatchObject({ ...base, status: "INVALID_OUTPUT" });
    expect(rows[0]!.id).toMatch(/^llm_/);
    expect(await repo.listByRun("run_other")).toEqual([]);
  });
});
