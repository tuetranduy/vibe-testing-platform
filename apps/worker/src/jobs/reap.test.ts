import { RunRepository, SecretRepository, SuiteRunRepository } from "@platform/db";
import { TEST_TENANT_ID } from "@platform/db/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createWorkerMetrics } from "../metrics";
import { createFakeStages, createHarness, eventsOf, seedRun, type WorkerHarness } from "../test-support";
import { reapJob } from "./reap";

let h: WorkerHarness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => h?.close());

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

describe("reaper", () => {
  it("marks an active run with a stale heartbeat ERRORED / WORKER_LOST", async () => {
    const run = await seedRun(h, { lifecycle: "ANALYZING_REQUIREMENT", secrets: { password: "pw-123456" } });
    await new RunRepository(h.tdb.db).heartbeat(run.id, minutesAgo(2));
    const r = await reapJob(h.deps(createFakeStages()));
    expect(r.workerLost).toContain(run.id);
    const after = await new RunRepository(h.tdb.db).getById(run.id);
    expect(after.lifecycle).toBe("ERRORED");
    expect(after.errorCategory).toBe("WORKER_LOST");
    expect((await eventsOf(h, run.id)).at(-1)).toMatchObject({ type: "run.errored", payload: { category: "WORKER_LOST" } });
    expect(await new SecretRepository(h.tdb.db).listActive(run.id)).toHaveLength(0);
  });

  it("cancels runs awaiting a selection past the TTL: CANCELLED / SELECTION_EXPIRED, secrets purged, counted", async () => {
    const run = await seedRun(h, { lifecycle: "AWAITING_SELECTION", requirement: "", secrets: { password: "pw-123456" } });
    const metrics = createWorkerMetrics();
    const r = await reapJob(h.deps(createFakeStages(), { metrics, now: () => new Date(Date.now() + 25 * 3_600_000) }));
    expect(r.selectionExpired).toContain(run.id);
    expect(r.confirmationExpired).not.toContain(run.id);
    const after = await new RunRepository(h.tdb.db).getById(run.id);
    expect(after.lifecycle).toBe("CANCELLED");
    expect(after.cancelReason).toBe("SELECTION_EXPIRED");
    expect((await eventsOf(h, run.id)).at(-1)).toMatchObject({ type: "run.cancelled", stage: "CANCELLED", payload: { reason: "SELECTION_EXPIRED" } });
    expect(await new SecretRepository(h.tdb.db).listActive(run.id)).toHaveLength(0);
    const reaped = await metrics.runsReaped.get();
    expect(reaped.values.find((v) => v.labels.reason === "SELECTION_EXPIRED")?.value).toBe(1);
  });

  it("leaves a run that has been awaiting a selection for less than the TTL alone", async () => {
    const run = await seedRun(h, { lifecycle: "AWAITING_SELECTION", requirement: "" });
    const r = await reapJob(h.deps(createFakeStages()));
    expect(r.selectionExpired).not.toContain(run.id);
    expect((await new RunRepository(h.tdb.db).getById(run.id)).lifecycle).toBe("AWAITING_SELECTION");
  });

  it("a SURVEYING run whose heartbeat stopped ends ERRORED / WORKER_LOST", async () => {
    const run = await seedRun(h, { lifecycle: "SURVEYING", requirement: "" });
    await new RunRepository(h.tdb.db).heartbeat(run.id, minutesAgo(2));
    const r = await reapJob(h.deps(createFakeStages()));
    expect(r.workerLost).toContain(run.id);
    expect(await new RunRepository(h.tdb.db).getById(run.id)).toMatchObject({ lifecycle: "ERRORED", errorCategory: "WORKER_LOST" });
  });

  it("cancels runs awaiting confirmation past the TTL", async () => {
    const run = await seedRun(h, { lifecycle: "AWAITING_CONFIRMATION" });
    const deps = h.deps(createFakeStages(), { now: () => new Date(Date.now() + 25 * 3_600_000) });
    const r = await reapJob(deps);
    expect(r.confirmationExpired).toContain(run.id);
    const after = await new RunRepository(h.tdb.db).getById(run.id);
    expect(after.lifecycle).toBe("CANCELLED");
    expect(after.cancelReason).toBe("CONFIRMATION_EXPIRED");
    expect((await eventsOf(h, run.id)).at(-1)).toMatchObject({ type: "run.cancelled", payload: { reason: "CONFIRMATION_EXPIRED" } });
  });

  it("leaves a selected run alone while its post-selection analyze job is still waiting in the queue", async () => {
    const run = await seedRun(h, { lifecycle: "ANALYZING_REQUIREMENT" });
    await new RunRepository(h.tdb.db).heartbeat(run.id, minutesAgo(5));
    h.queue.afterSelectionWaiting.add(run.id);
    const r = await reapJob(h.deps(createFakeStages()));
    expect(r.workerLost).not.toContain(run.id);
    expect((await new RunRepository(h.tdb.db).getById(run.id)).lifecycle).toBe("ANALYZING_REQUIREMENT");
    h.queue.afterSelectionWaiting.delete(run.id);
    expect((await reapJob(h.deps(createFakeStages()))).workerLost).toContain(run.id);
  });

  it("leaves a PLANNING run alone while its execute-run job is still waiting in the queue", async () => {
    const run = await seedRun(h, { lifecycle: "PLANNING" });
    await new RunRepository(h.tdb.db).heartbeat(run.id, minutesAgo(5));
    h.queue.waiting.add(run.id);
    const r = await reapJob(h.deps(createFakeStages()));
    expect(r.workerLost).not.toContain(run.id);
    expect((await new RunRepository(h.tdb.db).getById(run.id)).lifecycle).toBe("PLANNING");
    h.queue.waiting.delete(run.id);
    expect((await reapJob(h.deps(createFakeStages()))).workerLost).toContain(run.id);
  });

  it("leaves healthy runs and fresh confirmations untouched", async () => {
    const active = await seedRun(h, { lifecycle: "ANALYZING_REQUIREMENT" });
    await new RunRepository(h.tdb.db).heartbeat(active.id);
    const waiting = await seedRun(h, { lifecycle: "AWAITING_CONFIRMATION" });
    const queued = await seedRun(h);
    const r = await reapJob(h.deps(createFakeStages()));
    for (const id of [active.id, waiting.id, queued.id]) {
      expect(r.workerLost).not.toContain(id);
      expect(r.confirmationExpired).not.toContain(id);
    }
  });

  it("treats losing a CAS race to the worker as a non-error", async () => {
    const run = await seedRun(h, { lifecycle: "ANALYZING_REQUIREMENT" });
    const stale = await new RunRepository(h.tdb.db).getById(run.id);
    // The worker moves on between the reaper's read and its write.
    await new RunRepository(h.tdb.db).transition(run.id, "ANALYZING_REQUIREMENT", "AWAITING_CONFIRMATION");
    const spy = vi.spyOn(RunRepository.prototype, "findStale").mockResolvedValueOnce([stale]);
    const r = await reapJob(h.deps(createFakeStages()));
    spy.mockRestore();
    expect(r.workerLost).not.toContain(run.id);
    expect((await new RunRepository(h.tdb.db).getById(run.id)).lifecycle).toBe("AWAITING_CONFIRMATION");
  });

  it("errors QUEUED runs that were never picked up, but not ones still waiting in the queue", async () => {
    const lost = await seedRun(h);
    const waiting = await seedRun(h);
    h.queue.analyzePending.add(waiting.id);
    const deps = h.deps(createFakeStages(), { now: () => new Date(Date.now() + 11 * 60_000) });
    const r = await reapJob(deps);
    expect(r.neverStarted).toContain(lost.id);
    expect(r.neverStarted).not.toContain(waiting.id);
    expect((await new RunRepository(h.tdb.db).getById(lost.id)).errorCategory).toBe("INTERNAL");
    expect((await new RunRepository(h.tdb.db).getById(waiting.id)).lifecycle).toBe("QUEUED");
    h.queue.analyzePending.delete(waiting.id);
  });

  it("times out active runs past their hard deadline (+ grace)", async () => {
    const run = await seedRun(h, { lifecycle: "PLANNING" });
    const runs = new RunRepository(h.tdb.db);
    await runs.markExecutionStarted(run.id, { startedAt: minutesAgo(10), deadlineAt: minutesAgo(5) });
    await runs.heartbeat(run.id); // the worker is alive but stuck
    const r = await reapJob(h.deps(createFakeStages()));
    expect(r.timedOut).toContain(run.id);
    expect((await runs.getById(run.id)).errorCategory).toBe("TIMEOUT");
  });

  it("purges leftover secrets of terminal runs", async () => {
    const run = await seedRun(h, { secrets: { password: "pw-123456" } });
    await new RunRepository(h.tdb.db).transition(run.id, "QUEUED", "CANCELLED", { cancelReason: "USER_REQUESTED" });
    const r = await reapJob(h.deps(createFakeStages()));
    expect(r.secretsPurged).toContain(run.id);
    expect(await new SecretRepository(h.tdb.db).listActive(run.id)).toHaveLength(0);
  });

  it("settles a suite run whose children have all ended, and leaves one with an active child running", async () => {
    const suiteRuns = new SuiteRunRepository(h.tdb.db);
    const runs = new RunRepository(h.tdb.db);
    const make = () => suiteRuns.create({ tenantId: TEST_TENANT_ID, suiteId: "ste_x", suiteName: "Smoke", trigger: "manual", ownerUserId: null });
    const [done, busy] = [await make(), await make()];
    const child = await runs.create({ tenantId: TEST_TENANT_ID, targetUrl: "https://shop.example.com", request: (await seedRun(h)).request, suiteRunId: done.id });
    await runs.create({ tenantId: TEST_TENANT_ID, targetUrl: "https://shop.example.com", request: (await seedRun(h)).request, suiteRunId: busy.id });
    await runs.transition(child.id, "QUEUED", "CANCELLED", { cancelReason: "USER_REQUESTED" });

    const r = await reapJob(h.deps(createFakeStages()));
    expect(r.suiteRunsSettled).toContain(done.id);
    expect(r.suiteRunsSettled).not.toContain(busy.id);
    expect(await suiteRuns.findById(done.id)).toMatchObject({ status: "COMPLETED", verdict: "INCONCLUSIVE" });
    expect(await suiteRuns.findById(busy.id)).toMatchObject({ status: "RUNNING" });
  });
});
