import { createRunQueue } from "@platform/event-bus";
import { Redis } from "ioredis";
import { afterAll, describe, expect, inject, it } from "vitest";
import { CancelWatcher } from "../../apps/worker/src/cancel-watcher";
import { silentLogger, type WorkerDeps } from "../../apps/worker/src/deps";
import { reapJob } from "../../apps/worker/src/jobs/reap";
import { api, db } from "./support/client";
import { REQUIREMENTS } from "./support/scenarios";

const stack = inject("e2e");
const client = api(stack);
const store = db(stack);
afterAll(() => store.close());

describe("Task 21 step 8 — confirmation", () => {
  it("edit a check in review, confirm, complete: the report reflects revision 2", async () => {
    const runId = await client.create({ targetUrl: `${stack.targetUrl}/`, requirement: REQUIREMENTS.cart, options: { autoConfirmCriteria: false } });
    await client.waitFor(runId, (r) => r.lifecycle === "AWAITING_CONFIRMATION", 60_000);

    const rev1 = await client.criteria(runId);
    expect(rev1.revision).toBe(1);
    // The cart shows "iPhone 17 Pro": narrow the check from "iPhone" to "Pro".
    const edited = {
      ...rev1,
      criteria: rev1.criteria.map((c: { expectedOutcome: { kind: string } }) =>
        c.expectedOutcome.kind === "collection_contains" ? { ...c, expectedOutcome: { ...c.expectedOutcome, item: "Pro" } } : c,
      ),
    };
    const put = await client.putCriteria(runId, edited);
    expect(put.status).toBe(200);
    expect(put.json.revision).toBe(2);
    expect((await client.confirm(runId)).status).toBe(202);

    expect(await client.finished(runId)).toMatchObject({ lifecycle: "COMPLETED", verdict: "PASSED" });
    const report = await client.report(runId);
    expect(report.requirement?.revision).toBe(2);
    const contains = report.requirement!.criteria.find((c) => c.expectedOutcome.kind === "collection_contains")!;
    expect(contains.expectedOutcome).toMatchObject({ item: "Pro" });
    expect(report.criteria.find((r) => r.criterionId === contains.id)).toMatchObject({ status: "PASS", verdictSource: "PLAYWRIGHT_RERUN" });
  });

  it("an unconfirmed run past the TTL (fake clock, the worker's real reaper) ends CANCELLED / CONFIRMATION_EXPIRED", async () => {
    const runId = await client.create({ targetUrl: `${stack.targetUrl}/`, requirement: REQUIREMENTS.cart, options: { autoConfirmCriteria: false } });
    await client.waitFor(runId, (r) => r.lifecycle === "AWAITING_CONFIRMATION", 60_000);

    const redis = new Redis(stack.redisUrl);
    const queueConnection = new Redis(stack.redisUrl, { maxRetriesPerRequest: null });
    const watcher = new CancelWatcher(new Redis(stack.redisUrl, { maxRetriesPerRequest: null }));
    const queue = createRunQueue(queueConnection);
    try {
      const deps: WorkerDeps = {
        config: {
          secretsKey: Buffer.alloc(32),
          analysisTimeoutSeconds: 120,
          surveyTimeoutSeconds: 180,
          heartbeatMs: 10_000,
          staleAfterMs: 60_000,
          confirmationTtlHours: 24,
          queuedStaleAfterMs: 10 * 60_000,
          deadlineGraceMs: 60_000,
          timeScale: 1,
        },
        db: store.handle.db,
        redis,
        cancelWatcher: watcher,
        queue,
        engines: {} as WorkerDeps["engines"],
        runLlm: {} as WorkerDeps["runLlm"],
        logger: silentLogger,
        now: () => new Date(Date.now() + 25 * 3_600_000),
      };
      const reaped = await reapJob(deps);
      expect(reaped.confirmationExpired).toContain(runId);
    } finally {
      await queue.close();
      watcher.close();
      redis.disconnect();
      queueConnection.disconnect();
    }

    expect(await client.get(runId)).toMatchObject({ lifecycle: "CANCELLED", cancelReason: "CONFIRMATION_EXPIRED" });
    expect((await store.events(runId)).find((e) => e.type === "run.cancelled")?.payload).toEqual({ reason: "CONFIRMATION_EXPIRED" });
  });
});
