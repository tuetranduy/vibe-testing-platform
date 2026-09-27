import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiMetrics } from "./metrics";
import { FakeQueue, auth, createTestApi, validBody, type TestApi } from "./test-support";

let t: TestApi;
const queue = new FakeQueue();
const metrics = createApiMetrics({ queue });
beforeAll(async () => {
  t = await createTestApi({}, { queue, metrics });
});
afterAll(async () => t?.close());

const scrape = async () => {
  const res = await t.app.inject({ method: "GET", url: "/metrics" });
  return { status: res.statusCode, type: String(res.headers["content-type"]), text: res.body };
};

describe("GET /metrics", () => {
  it("is open like /healthz and reports the runs queue depth", async () => {
    queue.depthValue = 3;
    const { status, type, text } = await scrape();
    expect(status).toBe(200);
    expect(type).toContain("text/plain");
    expect(text).toMatch(/^queue_depth\{queue="runs"\} 3$/m);
  });

  it("counts runs the API ends itself (cancel before any worker holds them)", async () => {
    const created = await t.app.inject({ method: "POST", url: "/v1/test-runs", headers: auth, payload: validBody() });
    const { runId } = created.json();
    expect((await t.app.inject({ method: "POST", url: `/v1/test-runs/${runId}/cancel`, headers: auth })).statusCode).toBe(202);
    expect((await scrape()).text).toMatch(/^test_runs_total\{lifecycle="CANCELLED",verdict="none"\} 1$/m);
  });

  it("still answers when the queue cannot be read (Redis down): everything but queue_depth", async () => {
    queue.depthFails = true;
    try {
      const { status, text } = await scrape();
      expect(status).toBe(200);
      expect(text).not.toMatch(/^queue_depth\{/m);
      expect(text).toContain("# TYPE test_runs_total counter");
    } finally {
      queue.depthFails = false;
    }
  });
});
