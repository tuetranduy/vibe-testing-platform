import { RunRepository, SecretRepository } from "@platform/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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

  it("purges leftover secrets of terminal runs", async () => {
    const run = await seedRun(h, { secrets: { password: "pw-123456" } });
    await new RunRepository(h.tdb.db).transition(run.id, "QUEUED", "CANCELLED", { cancelReason: "USER_REQUESTED" });
    const r = await reapJob(h.deps(createFakeStages()));
    expect(r.secretsPurged).toContain(run.id);
    expect(await new SecretRepository(h.tdb.db).listActive(run.id)).toHaveLength(0);
  });
});
