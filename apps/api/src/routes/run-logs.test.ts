import { RunLogPageSchema, RunLlmCallsSchema } from "@platform/contracts";
import { LlmCallRepository, LlmExchangeRepository, RunLogRepository, RunRepository } from "@platform/db";
import { OTHER_TENANT_ID, TEST_TENANT_ID } from "@platform/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, createTestApi, signInMember, validBody, type TestApi } from "../test-support";

let t: TestApi;
const requestLines: { obj: Record<string, unknown>; msg: string | undefined }[] = [];
beforeAll(async () => {
  t = await createTestApi({}, { logger: { info: (obj: object, msg?: string) => void requestLines.push({ obj: obj as Record<string, unknown>, msg }) } });
});
afterAll(async () => t?.close());

const createRun = async (headers: Record<string, string> = auth) =>
  ((await t.app.inject({ method: "POST", url: "/v1/test-runs", headers, payload: validBody() })).json() as { runId: string }).runId;

const otherTenantRun = async () => {
  const runs = new RunRepository(t.tdb.db);
  const ours = await runs.getById(await createRun());
  return (await runs.create({ tenantId: OTHER_TENANT_ID, targetUrl: ours.targetUrl, request: ours.request })).id;
};

const line = (runId: string, s: number, over: Record<string, unknown> = {}) => ({
  runId,
  time: new Date(Date.UTC(2026, 10, 25, 10, 0, s)),
  source: "worker" as const,
  level: "info" as const,
  stage: "EXPLORING" as const,
  component: "worker",
  message: `m${s}`,
  fields: {},
  ...over,
});

const newCall = (runId: string) =>
  new LlmCallRepository(t.tdb.db).create({
    runId, stage: "EXPLORING", provider: "anthropic", model: "claude-sonnet-5",
    inputTokens: 100, outputTokens: 10, estimatedCostUsd: 0.01, latencyMs: 500, status: "SUCCESS", purpose: "Observation",
  });

const get = (url: string, headers: Record<string, string>) => t.app.inject({ method: "GET", url, headers });

describe("admin run logs routes", () => {
  it("member gets 403 on every read route", async () => {
    const member = await signInMember(t);
    const runId = await createRun(member.headers);
    const call = await newCall(runId);
    for (const url of [`/v1/test-runs/${runId}/logs`, `/v1/test-runs/${runId}/llm-calls`, `/v1/test-runs/${runId}/llm-calls/${call.id}/exchange`]) {
      expect((await get(url, member.headers)).statusCode, url).toBe(403);
    }
  });

  it("other tenant's run is 404", async () => {
    const admin = await signInMember(t, "admin");
    const runId = await otherTenantRun();
    expect((await get(`/v1/test-runs/${runId}/logs`, admin.headers)).statusCode).toBe(404);
    expect((await get(`/v1/test-runs/${runId}/llm-calls`, admin.headers)).statusCode).toBe(404);
  });

  it("admin pages logs with filters", async () => {
    const admin = await signInMember(t, "admin");
    const runId = await createRun();
    await new RunLogRepository(t.tdb.db).appendMany([
      line(runId, 0),
      line(runId, 1, { source: "infra", level: "warn" }),
      line(runId, 2, { level: "error" }),
    ]);
    const first = await get(`/v1/test-runs/${runId}/logs?limit=2`, admin.headers);
    expect(first.statusCode).toBe(200);
    const page = RunLogPageSchema.parse(first.json());
    expect(page.lines.map((l) => l.message)).toEqual(["m0", "m1"]);
    const next = RunLogPageSchema.parse((await get(`/v1/test-runs/${runId}/logs?limit=2&after=${page.nextCursor}`, admin.headers)).json());
    expect(next).toMatchObject({ lines: [{ message: "m2" }], nextCursor: null });
    const filtered = RunLogPageSchema.parse((await get(`/v1/test-runs/${runId}/logs?source=infra,worker&minLevel=warn`, admin.headers)).json());
    expect(filtered.lines.map((l) => l.message)).toEqual(["m1", "m2"]);
    expect((await get(`/v1/test-runs/${runId}/logs?source=disk`, admin.headers)).statusCode).toBe(400);
  });

  it("llm-calls lists calls with totals and exchange availability", async () => {
    const admin = await signInMember(t, "admin");
    const runId = await createRun();
    const a = await newCall(runId);
    const b = await newCall(runId);
    await new LlmExchangeRepository(t.tdb.db).put(a.id, runId, { system: "s", messages: [], response: "r", error: null, truncated: false });
    await t.tdb.pool.query("UPDATE llm_calls SET created_at = now() - interval '20 days' WHERE id = $1", [b.id]);
    const res = await get(`/v1/test-runs/${runId}/llm-calls`, admin.headers);
    expect(res.statusCode).toBe(200);
    const body = RunLlmCallsSchema.parse(res.json());
    expect(body.calls.map((c) => [c.id, c.exchange, c.purpose])).toEqual([
      [b.id, "expired", "Observation"],
      [a.id, "available", "Observation"],
    ]);
    expect(body.totals).toEqual({ calls: 2, inputTokens: 200, outputTokens: 20, estimatedCostUsd: 0.02 });
    const ex = await get(`/v1/test-runs/${runId}/llm-calls/${a.id}/exchange`, admin.headers);
    expect(ex.json()).toEqual({ system: "s", messages: [], response: "r", error: null, truncated: false });
  });

  it("expired exchange is 410", async () => {
    const admin = await signInMember(t, "admin");
    const runId = await createRun();
    const call = await newCall(runId);
    const res = await get(`/v1/test-runs/${runId}/llm-calls/${call.id}/exchange`, admin.headers);
    expect(res.statusCode).toBe(410);
    expect(res.json()).toMatchObject({ code: "EXCHANGE_EXPIRED" });
    expect((await get(`/v1/test-runs/${runId}/llm-calls/llm_nope/exchange`, admin.headers)).statusCode).toBe(404);
  });
});

describe("client-logs", () => {
  const batch = (n: number, message = "TypeError: x is undefined") => ({
    lines: Array.from({ length: n }, () => ({ time: "2026-11-25T10:00:00.000Z", level: "error", message, url: "https://app/runs/x", kind: "error" })),
  });
  const post = (runId: string, headers: Record<string, string>, payload: object) =>
    t.app.inject({ method: "POST", url: `/v1/test-runs/${runId}/client-logs`, headers, payload });

  it("client-logs stores web_app lines for a member who owns the run", async () => {
    const member = await signInMember(t);
    const runId = await createRun(member.headers);
    expect((await post(runId, member.headers, batch(2))).statusCode).toBe(204);
    const lines = (await new RunLogRepository(t.tdb.db).list(TEST_TENANT_ID, runId, { limit: 10, source: ["web_app"] })).lines;
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ source: "web_app", level: "error", component: "web", message: "TypeError: x is undefined", fields: { userId: member.userId, kind: "error", url: "https://app/runs/x" } });
  });

  it("rejects 51 lines with 400", async () => {
    const member = await signInMember(t);
    const runId = await createRun(member.headers);
    expect((await post(runId, member.headers, batch(51))).statusCode).toBe(400);
  });

  it("drops lines past 300 per user and still answers 204", async () => {
    const member = await signInMember(t);
    const runId = await createRun(member.headers);
    for (let i = 0; i < 7; i++) expect((await post(runId, member.headers, batch(50))).statusCode).toBe(204);
    expect(await new RunLogRepository(t.tdb.db).countWebAppLines(runId, member.userId)).toBe(300);
  });

  it("another member's run is 404", async () => {
    const owner = await signInMember(t);
    const other = await signInMember(t);
    const runId = await createRun(owner.headers);
    expect((await post(runId, other.headers, batch(1))).statusCode).toBe(404);
  });

  it("the service token cannot send client logs", async () => {
    const runId = await createRun();
    expect((await post(runId, auth, batch(1))).statusCode).toBe(403);
  });
});

describe("request lines", () => {
  it("actions and failed requests on a run's routes write a request line; successful reads and the logs routes do not", async () => {
    const admin = await signInMember(t, "admin");
    const runId = await createRun();
    requestLines.length = 0;
    await get(`/v1/test-runs/${runId}`, admin.headers);
    await get(`/v1/test-runs/${runId}/logs`, admin.headers);
    await get(`/v1/test-runs/${runId}/llm-calls/llm_nope/exchange`, admin.headers);
    await get(`/v1/test-runs/${runId}/criteria`, admin.headers);
    await t.app.inject({ method: "POST", url: `/v1/test-runs/${runId}/cancel`, headers: admin.headers });
    const mine = requestLines.filter((l) => l.obj.runId === runId);
    expect(mine.map((l) => [l.obj.method, l.obj.route, l.obj.status])).toEqual([
      ["GET", "/v1/test-runs/:runId/criteria", 409],
      ["POST", "/v1/test-runs/:runId/cancel", 202],
    ]);
    expect(mine.map((l) => l.msg)).toEqual(["GET /v1/test-runs/:runId/criteria → 409", "POST /v1/test-runs/:runId/cancel → 202"]);
    expect(mine[1]).toMatchObject({ obj: { principal: "user" } });
    expect(typeof mine[1]!.obj.durationMs).toBe("number");
  });
});
