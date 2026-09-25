import { RequirementRepository, RunRepository, SecretRepository } from "@platform/db";
import { ModelProviderError } from "@platform/testing-engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeStages, createHarness, eventsOf, seedRun, type WorkerHarness } from "../test-support";
import { analyzeRunJob } from "./analyze-run";

let h: WorkerHarness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => h?.close());

describe("analyze-run", () => {
  it("autoConfirmCriteria=false: QUEUED → ANALYZING_REQUIREMENT → AWAITING_CONFIRMATION, no execute-run", async () => {
    const run = await seedRun(h, { secrets: { password: "pw-123456" } });
    await analyzeRunJob(h.deps(createFakeStages()), run.id);
    const after = await new RunRepository(h.tdb.db).getById(run.id);
    expect(after.lifecycle).toBe("AWAITING_CONFIRMATION");
    expect(after.heartbeatAt).toBeNull();
    const events = await eventsOf(h, run.id);
    expect(events.map((e) => e.type)).toEqual(["stage.started", "criteria.proposed", "stage.completed"]);
    const proposed = events.find((e) => e.type === "criteria.proposed")!;
    expect(proposed.message).toBe("2 acceptance criteria identified");
    expect(proposed.stage).toBe("ANALYZING_REQUIREMENT");
    expect((await new RequirementRepository(h.tdb.db).getLatest(run.id)).revision).toBe(1);
    expect(h.queue.execute).not.toContain(run.id);
    // Secrets stay until the run ends: the user hasn't confirmed yet.
    expect(await new SecretRepository(h.tdb.db).listActive(run.id)).toHaveLength(1);
  });

  it("autoConfirmCriteria=true: ends at PLANNING and enqueues execute-run", async () => {
    const run = await seedRun(h, { options: { autoConfirmCriteria: true } });
    await analyzeRunJob(h.deps(createFakeStages()), run.id);
    const after = await new RunRepository(h.tdb.db).getById(run.id);
    expect(after.lifecycle).toBe("PLANNING");
    expect(after.heartbeatAt).toBeInstanceOf(Date);
    expect(h.queue.execute).toContain(run.id);
    expect((await new RequirementRepository(h.tdb.db).getLatest(run.id)).confirmedAt).not.toBeNull();
    expect((await eventsOf(h, run.id)).map((e) => e.type)).toContain("criteria.confirmed");
  });

  it("skips runs that are no longer QUEUED (e.g. cancelled before pickup)", async () => {
    const run = await seedRun(h);
    await new RunRepository(h.tdb.db).transition(run.id, "QUEUED", "CANCELLED", { cancelReason: "USER_REQUESTED" });
    await analyzeRunJob(h.deps(createFakeStages()), run.id);
    expect((await new RunRepository(h.tdb.db).getById(run.id)).lifecycle).toBe("CANCELLED");
    expect(await eventsOf(h, run.id)).toEqual([]);
  });

  it("maps a model failure to ERRORED / MODEL_PROVIDER and purges secrets", async () => {
    const run = await seedRun(h, { secrets: { password: "pw-123456" } });
    const stages = createFakeStages({ failAt: { stage: "analyze", error: new ModelProviderError("provider 503 for pw-123456") } });
    await analyzeRunJob(h.deps(stages), run.id);
    const after = await new RunRepository(h.tdb.db).getById(run.id);
    expect(after.lifecycle).toBe("ERRORED");
    expect(after.errorCategory).toBe("MODEL_PROVIDER");
    expect(after.errorMessage).not.toContain("pw-123456");
    const errored = (await eventsOf(h, run.id)).find((e) => e.type === "run.errored")!;
    expect(errored.payload).toEqual({ category: "MODEL_PROVIDER", message: "provider 503 for [REDACTED]" });
    expect(await new SecretRepository(h.tdb.db).listActive(run.id)).toHaveLength(0);
  });

  it("times out analysis after ANALYSIS_TIMEOUT_SECONDS → ERRORED / TIMEOUT", async () => {
    const run = await seedRun(h);
    const stages = createFakeStages({ analyzeDelayMs: 5_000 });
    const deps = h.deps(stages);
    deps.config.analysisTimeoutSeconds = 10; // × timeScale 0.01 = 100 ms
    await analyzeRunJob(deps, run.id);
    const after = await new RunRepository(h.tdb.db).getById(run.id);
    expect(after.lifecycle).toBe("ERRORED");
    expect(after.errorCategory).toBe("TIMEOUT");
  });
});
