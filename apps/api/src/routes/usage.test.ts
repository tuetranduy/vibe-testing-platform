import { LlmCallRepository, RunRepository, UserRepository } from "@platform/db";
import { TEST_TENANT_ID, storedRequest } from "@platform/db/testing";
import { hashPassword } from "@platform/security";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, createTestApi, type TestApi } from "../test-support";

let t: TestApi;
beforeAll(async () => {
  t = await createTestApi();
});
afterAll(async () => t?.close());

const get = (url: string, headers: Record<string, string> = auth) => t.app.inject({ method: "GET", url, headers });

async function call(runId: string, at: string, cost: number) {
  const row = await new LlmCallRepository(t.tdb.db).create({
    runId,
    stage: "PLANNING",
    provider: "anthropic",
    model: "claude-sonnet-5",
    inputTokens: 100,
    outputTokens: 10,
    estimatedCostUsd: cost,
    latencyMs: 1,
    status: "ok",
  });
  await t.tdb.pool.query("UPDATE llm_calls SET created_at = $1 WHERE id = $2", [at, row.id]);
}

describe("GET /v1/usage (V1.1 F7)", () => {
  it("reports a range with every day filled, the model's label, and the most expensive runs", async () => {
    const run = await new RunRepository(t.tdb.db).create({
      tenantId: TEST_TENANT_ID,
      targetUrl: "https://shop.example.com",
      request: storedRequest(),
    });
    await call(run.id, "2026-08-02T10:00:00Z", 0.25);
    await call(run.id, "2026-08-04T10:00:00Z", 0.5);
    const res = await get("/v1/usage?from=2026-08-01&to=2026-08-05");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      from: "2026-08-01",
      to: "2026-08-05",
      scope: "all",
      totals: { runs: 1, llmCalls: 2, estimatedCostUsd: 0.75 },
    });
    expect(body.byDay.map((d: { day: string; estimatedCostUsd: number }) => [d.day, d.estimatedCostUsd])).toEqual([
      ["2026-08-01", 0],
      ["2026-08-02", 0.25],
      ["2026-08-03", 0],
      ["2026-08-04", 0.5],
      ["2026-08-05", 0],
    ]);
    expect(body.byModel[0]).toMatchObject({ model: "claude-sonnet-5", label: expect.any(String), llmCalls: 2 });
    expect(body.topRuns[0]).toMatchObject({ runId: run.id, targetUrl: "https://shop.example.com", owner: null, estimatedCostUsd: 0.75 });
  });

  it("defaults to the last 30 days and refuses bad ranges", async () => {
    const res = await get("/v1/usage");
    expect(res.statusCode).toBe(200);
    expect(res.json().byDay).toHaveLength(30);
    expect((await get("/v1/usage?from=2026-08-05&to=2026-08-01")).statusCode).toBe(400);
    expect((await get("/v1/usage?from=2024-01-01&to=2026-01-01")).statusCode).toBe(400);
    expect((await get("/v1/usage?from=yesterday")).statusCode).toBe(400);
  });

  it("members see only their own runs' spend", async () => {
    const email = `usage-${Date.now()}@example.com`;
    const user = await new UserRepository(t.tdb.db).create({
      tenantId: TEST_TENANT_ID,
      email,
      name: "Spender",
      role: "member",
      passwordHash: await hashPassword("member password", { N: 1024 }),
    });
    const token = (
      await t.app.inject({ method: "POST", url: "/v1/auth/login", headers: auth, payload: { email, password: "member password" } })
    ).json().token;
    const mine = await new RunRepository(t.tdb.db).create({
      tenantId: TEST_TENANT_ID,
      targetUrl: "https://mine.example",
      request: storedRequest(),
      ownerUserId: user.id,
    });
    await call(mine.id, "2026-07-02T10:00:00Z", 0.1);
    const other = await new RunRepository(t.tdb.db).create({
      tenantId: TEST_TENANT_ID,
      targetUrl: "https://other.example",
      request: storedRequest(),
    });
    await call(other.id, "2026-07-02T10:00:00Z", 3);
    const res = await get("/v1/usage?from=2026-07-01&to=2026-07-03&owner=all", { ...auth, "x-session-token": token });
    expect(res.json()).toMatchObject({ scope: "mine", totals: { llmCalls: 1, estimatedCostUsd: 0.1 } });
    expect(res.json().topRuns.map((r: { runId: string }) => r.runId)).toEqual([mine.id]);
    expect(res.json().topRuns[0].owner).toEqual({ id: user.id, name: "Spender" });
  });
});
