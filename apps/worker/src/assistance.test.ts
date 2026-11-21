import { Redis } from "ioredis";
import { runAssistAnswerKey, runAssistChannel, runAssistKey } from "@platform/event-bus";
import { CancelledError, type AssistanceRequest } from "@platform/testing-engine";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAssistancePort } from "./assistance";
import { REDIS_URL } from "./test-support";

let redis: Redis;
beforeAll(() => { redis = new Redis(REDIS_URL); });
afterAll(() => redis.disconnect());
const request = (requestId: string, ms = 5000): AssistanceRequest => ({
  requestId, scenarioId: "SC-1", failedStep: { id: "PS-2", kind: "click", description: "Checkout", criterionIds: [], destructive: false },
  reason: "Control missing", url: "https://shop.test/cart", screenshotArtifactId: "art_1", question: "What next?", expiresAt: new Date(Date.now() + ms).toISOString(),
});

describe("Redis assistance port (2026-11-21)", () => {
  it("retains a pending question and consumes a retained answer even without a notification", async () => {
    const runId = `assist_${crypto.randomUUID()}`;
    const port = createAssistancePort(redis, runId);
    const req = request("request1");
    const wait = port.ask(req, new AbortController().signal);
    await vi.waitFor(async () => expect(await redis.get(runAssistKey(runId))).not.toBeNull());
    const answer = { kind: "instruction", text: "Accept terms", by: "u1" };
    await redis.set(runAssistAnswerKey(runId, req.requestId), JSON.stringify(answer));
    expect(await wait).toEqual(answer);
    expect(await redis.exists(runAssistKey(runId), runAssistAnswerKey(runId, req.requestId))).toBe(0);
  });
  it("can accept an answer before ask subscribes, then closes on stop", async () => {
    const runId = `assist_${crypto.randomUUID()}`;
    const port = createAssistancePort(redis, runId);
    const req = request("request2");
    const signal = new AbortController().signal;
    await port.prepare!(req, signal);
    await redis.set(runAssistAnswerKey(runId, req.requestId), JSON.stringify({ kind: "stop" }));
    await redis.del(runAssistKey(runId));
    await redis.publish(runAssistChannel(runId), req.requestId);
    expect(await port.ask(req, signal)).toEqual({ kind: "stop" });
    expect(await redis.get(runAssistKey(runId))).toBeNull();
  });
  it("times out and cancels without leaving pending state", async () => {
    const runId = `assist_${crypto.randomUUID()}`;
    const port = createAssistancePort(redis, runId, 50);
    expect(await port.ask(request("timeout", 50), new AbortController().signal)).toEqual({ kind: "timeout" });
    const cancel = new AbortController();
    const wait = port.ask(request("cancel"), cancel.signal);
    await vi.waitFor(async () => expect(await redis.get(runAssistKey(runId))).not.toBeNull());
    cancel.abort(new CancelledError());
    await expect(wait).rejects.toBeInstanceOf(CancelledError);
    expect(await redis.get(runAssistKey(runId))).toBeNull();
  });
});
