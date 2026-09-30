import { RequirementRepository, RunRepository, schema } from "@platform/db";
import { eq } from "drizzle-orm";
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

  it("times the stages it ends: AWAITING_CONFIRMATION when criteria are confirmed, QUEUED when a run is cancelled", async () => {
    const runs = new RunRepository(t.tdb.db);
    /** Moves the run's entry into its current stage `seconds` into the past. */
    const enteredAgo = (runId: string, seconds: number) =>
      t.tdb.db.update(schema.testRuns).set({ lifecycleChangedAt: new Date(Date.now() - seconds * 1000) }).where(eq(schema.testRuns.id, runId));
    const created = async () => (await t.app.inject({ method: "POST", url: "/v1/test-runs", headers: auth, payload: validBody() })).json().runId as string;

    const awaiting = await created();
    await runs.transition(awaiting, "QUEUED", "ANALYZING_REQUIREMENT");
    await runs.transition(awaiting, "ANALYZING_REQUIREMENT", "AWAITING_CONFIRMATION");
    await new RequirementRepository(t.tdb.db).createRevision(awaiting, {
      originalText: validBody().requirement,
      criteria: [
        {
          id: "AC-1",
          sourceText: "add a product to the cart",
          statement: "The cart shows the product",
          expectedOutcome: { kind: "text_matches", fact: { key: "cart", checkpoint: "after_add" }, match: { mode: "contains", value: "x", caseSensitive: false } },
          preconditions: [],
          critical: true,
          ambiguity: null,
        },
      ],
      facts: [{ key: "cart", checkpoint: "after_add", description: "The cart", valueType: "string" }],
    });
    await enteredAgo(awaiting, 120);
    expect((await t.app.inject({ method: "POST", url: `/v1/test-runs/${awaiting}/criteria/confirm`, headers: auth })).statusCode).toBe(202);

    const queued = await created();
    await enteredAgo(queued, 30);
    expect((await t.app.inject({ method: "POST", url: `/v1/test-runs/${queued}/cancel`, headers: auth })).statusCode).toBe(202);

    const { text } = await scrape();
    const sample = (series: string, stage: string) =>
      Number(new RegExp(`^test_run_duration_seconds_${series}\\{stage="${stage}"\\} (\\S+)$`, "m").exec(text)?.[1] ?? 0);
    expect(sample("count", "AWAITING_CONFIRMATION")).toBe(1);
    expect(sample("sum", "AWAITING_CONFIRMATION")).toBeGreaterThanOrEqual(120);
    expect(sample("sum", "QUEUED")).toBeGreaterThanOrEqual(30);
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

  it("answers promptly when the queue never replies (ioredis holds commands while Redis reconnects): no queue_depth, everything else", async () => {
    queue.depthHangs = true;
    try {
      const started = Date.now();
      const { status, text } = await scrape();
      expect(status).toBe(200);
      expect(Date.now() - started).toBeLessThan(2_500);
      expect(text).not.toMatch(/^queue_depth\{/m);
      expect(text).toContain("# TYPE test_runs_total counter");
    } finally {
      queue.depthHangs = false;
    }
  });
});
