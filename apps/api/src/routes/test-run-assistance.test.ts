import { RunRepository } from "@platform/db";
import { runAssistKey, runAssistAnswerKey } from "@platform/event-bus";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, createTestApi, signInMember, validBody, type TestApi } from "../test-support";
let t: TestApi;
beforeAll(async () => { t = await createTestApi(); });
afterAll(async () => t?.close());
async function pending(headers: Record<string, string> = auth) {
  const created = await t.app.inject({ method: "POST", url: "/v1/test-runs", headers, payload: validBody() });
  const runId = created.json().runId as string;
  const runs = new RunRepository(t.tdb.db);
  for (const [from, to] of [["QUEUED", "ANALYZING_REQUIREMENT"], ["ANALYZING_REQUIREMENT", "AWAITING_CONFIRMATION"], ["AWAITING_CONFIRMATION", "PLANNING"], ["PLANNING", "EXPLORING"]] as const) await runs.transition(runId, from, to);
  await t.redis.set(runAssistKey(runId), JSON.stringify({ requestId: "req_1" }), "PX", 60000);
  return { runId, url: `/v1/test-runs/${runId}/assistance/req_1` };
}
describe("POST run assistance (2026-11-21)", () => {
  it.each([{ instruction: "Accept the terms, then checkout" }, { stop: true }])("accepts %j once", async (payload) => {
    const { runId, url } = await pending();
    expect((await t.app.inject({ method: "POST", url, headers: auth, payload })).statusCode).toBe(202);
    expect(JSON.parse((await t.redis.get(runAssistAnswerKey(runId, "req_1")))!)).toMatchObject("instruction" in payload ? { kind: "instruction", text: payload.instruction, by: "service" } : { kind: "stop" });
    const duplicate = await t.app.inject({ method: "POST", url, headers: auth, payload });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().code).toBe("ASSISTANCE_NOT_PENDING");
  });
  it("rejects a stale request id without claiming the open question", async () => {
    const { runId, url } = await pending();
    expect((await t.app.inject({ method: "POST", url: url.replace("req_1", "old"), headers: auth, payload: { stop: true } })).statusCode).toBe(409);
    expect(await t.redis.get(runAssistKey(runId))).not.toBeNull();
  });
  it.each([{ instruction: " " }, { instruction: "a".repeat(2001) }, { stop: false }, { instruction: "x", stop: true }, {}])("validates %j", async (payload) => {
    const { url } = await pending();
    expect((await t.app.inject({ method: "POST", url, headers: auth, payload })).statusCode).toBe(400);
  });
  it("requires authentication and ownership", async () => {
    const owner = await signInMember(t);
    const other = await signInMember(t);
    const { url } = await pending(owner.headers);
    expect((await t.app.inject({ method: "POST", url, payload: { stop: true } })).statusCode).toBe(401);
    expect((await t.app.inject({ method: "POST", url, headers: other.headers, payload: { stop: true } })).statusCode).toBe(404);
    expect((await t.app.inject({ method: "POST", url, headers: owner.headers, payload: { instruction: "Click accept" } })).statusCode).toBe(202);
  });
});
