import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LlmCallRepository } from "./llm-call-repository";
import { RunRepository } from "./run-repository";
import { OTHER_TENANT_ID, TEST_TENANT_ID, createTestDatabase, storedRequest, type TestDatabase } from "./testing";
import { UsageRepository } from "./usage-repository";
import { UserRepository } from "./user-repository";

let tdb: TestDatabase;
beforeAll(async () => {
  tdb = await createTestDatabase();
});
afterAll(async () => tdb?.drop());

async function callAt(
  runId: string,
  at: string,
  patch: { stage?: "PLANNING" | "EXPLORING"; model?: string; cost?: number; input?: number } = {},
) {
  const row = await new LlmCallRepository(tdb.db).create({
    runId,
    stage: patch.stage ?? "PLANNING",
    provider: "anthropic",
    model: patch.model ?? "claude-sonnet-5",
    inputTokens: patch.input ?? 1000,
    outputTokens: 100,
    estimatedCostUsd: patch.cost ?? 0.01,
    latencyMs: 5,
    status: "ok",
  });
  await tdb.pool.query("UPDATE llm_calls SET created_at = $1 WHERE id = $2", [at, row.id]);
}

describe("UsageRepository (V1.1 F7)", () => {
  it("sums a tenant's calls in [from, to) by day, model, stage and run; scoped to an owner on request", async () => {
    const runs = new RunRepository(tdb.db);
    const user = await new UserRepository(tdb.db).create({
      tenantId: TEST_TENANT_ID,
      email: "u@example.com",
      name: "U",
      passwordHash: "h",
      role: "member",
    });
    const a = await runs.create({
      tenantId: TEST_TENANT_ID,
      targetUrl: "https://a.example",
      request: storedRequest(),
      ownerUserId: user.id,
    });
    const b = await runs.create({ tenantId: TEST_TENANT_ID, targetUrl: "https://b.example", request: storedRequest() });
    const other = await runs.create({ tenantId: OTHER_TENANT_ID, targetUrl: "https://c.example", request: storedRequest() });
    await callAt(a.id, "2026-09-10T23:59:00Z", { cost: 0.02 });
    await callAt(a.id, "2026-09-11T00:01:00Z", { stage: "EXPLORING", model: "gemini-3.8-flash", cost: 0.005, input: 500 });
    await callAt(b.id, "2026-09-11T12:00:00Z", { cost: 0.1 });
    await callAt(b.id, "2026-09-20T00:00:00Z", { cost: 5 }); // outside the range
    await callAt(other.id, "2026-09-11T12:00:00Z", { cost: 9 }); // another tenant

    const usage = new UsageRepository(tdb.db);
    const all = await usage.summarize({ tenantId: TEST_TENANT_ID }, new Date("2026-09-10T00:00:00Z"), new Date("2026-09-12T00:00:00Z"));
    expect(all.totals).toEqual({ runs: 2, llmCalls: 3, inputTokens: 2500, outputTokens: 300, estimatedCostUsd: expect.closeTo(0.125, 9) });
    expect(all.byDay).toEqual([
      { day: "2026-09-10", llmCalls: 1, estimatedCostUsd: expect.closeTo(0.02, 9) },
      { day: "2026-09-11", llmCalls: 2, estimatedCostUsd: expect.closeTo(0.105, 9) },
    ]);
    expect(all.byModel.map((m) => [m.model, m.llmCalls])).toEqual([
      ["claude-sonnet-5", 2],
      ["gemini-3.8-flash", 1],
    ]);
    expect(all.byStage.map((s) => [s.stage, s.llmCalls])).toEqual([
      ["PLANNING", 2],
      ["EXPLORING", 1],
    ]);
    expect(all.topRuns.map((r) => r.runId)).toEqual([b.id, a.id]);

    const mine = await usage.summarize(
      { tenantId: TEST_TENANT_ID, ownerUserId: user.id },
      new Date("2026-09-10T00:00:00Z"),
      new Date("2026-09-12T00:00:00Z"),
    );
    expect(mine.totals).toMatchObject({ runs: 1, llmCalls: 2 });
    expect(mine.topRuns.map((r) => r.runId)).toEqual([a.id]);

    const empty = await usage.summarize({ tenantId: TEST_TENANT_ID }, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-02T00:00:00Z"));
    expect(empty).toEqual({
      totals: { runs: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
      byDay: [],
      byModel: [],
      byStage: [],
      topRuns: [],
    });
  });
});
