import { EventRepository, ResultRepository, RunRepository, SecretRepository, SiteAnalysisRepository } from "@platform/db";
import { encryptSecret } from "@platform/security";
import { ModelProviderError } from "@platform/testing-engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeStages, createHarness, eventsOf, requestCancel, seedRun, type WorkerHarness } from "../test-support";
import { executeRunJob } from "./execute-run";

let h: WorkerHarness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => h?.close());

const stagesOf = async (runId: string, type: string) =>
  (await eventsOf(h, runId)).filter((e) => e.type === type).map((e) => (e.payload as { stage: string }).stage);

const lifecycleTrail = async (runId: string) => {
  const seen: string[] = [];
  for (const e of await eventsOf(h, runId)) if (seen.at(-1) !== e.stage) seen.push(e.stage);
  return seen;
};

describe("execute-run happy paths", () => {
  it("walks PLANNING → … → COMPLETED with a verdict and stage events for each stage", async () => {
    const run = await seedRun(h, { lifecycle: "PLANNING", secrets: { password: "pw-123456" } });
    await executeRunJob(h.deps(createFakeStages()), run.id);
    const after = await new RunRepository(h.tdb.db).getById(run.id);
    expect(after.lifecycle).toBe("COMPLETED");
    expect(after.verdict).toBe("PASSED");
    expect(after.deadlineAt).toBeInstanceOf(Date);
    expect(after.startedAt).toBeInstanceOf(Date);
    expect(await lifecycleTrail(run.id)).toEqual([
      "PLANNING",
      "EXPLORING",
      "VERIFYING",
      "GENERATING_TEST",
      "RUNNING_PLAYWRIGHT",
      "GENERATING_REPORT",
      "COMPLETED",
    ]);
    const all = ["PLANNING", "EXPLORING", "VERIFYING", "GENERATING_TEST", "RUNNING_PLAYWRIGHT", "GENERATING_REPORT"];
    expect(await stagesOf(run.id, "stage.started")).toEqual(all);
    expect(await stagesOf(run.id, "stage.completed")).toEqual(all);
    const types = (await eventsOf(h, run.id)).map((e) => e.type);
    expect(types).toContain("plan.created");
    expect(types).toContain("test.generated");
    expect(types).toContain("playwright.completed");
    expect(types.at(-1)).toBe("run.completed");
    const final = (await eventsOf(h, run.id)).filter((e) => e.type === "criterion.evaluated");
    expect(final.map((e) => (e.payload as { provisional: boolean }).provisional)).toEqual([true, true, false, false]);
    expect(await new SecretRepository(h.tdb.db).listActive(run.id)).toHaveLength(0);
  });

  it("takes the suggested test data the user did not accept or give before planning (2026-10-07)", async () => {
    const run = await seedRun(h, { lifecycle: "PLANNING", testData: { city: "Oslo" } });
    await new SiteAnalysisRepository(h.tdb.db).save(run.id, {
      status: "READ",
      reason: null,
      pages: [],
      checks: [],
      testData: [
        { key: "email", value: "qa.abc123@example.com", description: "Email to register with", source: "GENERATED" },
        { key: "city", value: "Springfield", description: "City", source: "GENERATED" },
      ],
    });
    let seen: Record<string, unknown> = {};
    const fake = createFakeStages();
    await executeRunJob(h.deps({ ...fake, plan: async (ctx, requirement, site) => ((seen = { ...ctx.request.testData }), fake.plan(ctx, requirement, site)) }), run.id);
    expect(seen).toEqual({ city: "Oslo", email: "qa.abc123@example.com" });
    expect((await new RunRepository(h.tdb.db).getById(run.id)).request.testData).toEqual({ city: "Oslo", email: "qa.abc123@example.com" });
    expect(await new SiteAnalysisRepository(h.tdb.db).get(run.id)).toMatchObject({ appliedKeys: ["email"] });
  });

  it("generatePlaywright=false: VERIFYING → GENERATING_REPORT with both generation stages skipped", async () => {
    const run = await seedRun(h, { lifecycle: "PLANNING", options: { generatePlaywright: false, rerunGeneratedTest: false } });
    await executeRunJob(h.deps(createFakeStages()), run.id);
    expect(await lifecycleTrail(run.id)).toEqual(["PLANNING", "EXPLORING", "VERIFYING", "GENERATING_REPORT", "COMPLETED"]);
    expect(await stagesOf(run.id, "stage.skipped")).toEqual(["GENERATING_TEST", "RUNNING_PLAYWRIGHT"]);
    expect((await new RunRepository(h.tdb.db).getById(run.id)).verdict).toBe("PASSED");
  });

  it("rerunGeneratedTest=false: GENERATING_TEST → GENERATING_REPORT", async () => {
    const run = await seedRun(h, { lifecycle: "PLANNING", options: { rerunGeneratedTest: false } });
    await executeRunJob(h.deps(createFakeStages()), run.id);
    expect(await lifecycleTrail(run.id)).toEqual(["PLANNING", "EXPLORING", "VERIFYING", "GENERATING_TEST", "GENERATING_REPORT", "COMPLETED"]);
    expect(await stagesOf(run.id, "stage.skipped")).toEqual(["RUNNING_PLAYWRIGHT"]);
  });

  it("plan blocks every criterion: PLANNING → GENERATING_REPORT, verdict BLOCKED", async () => {
    const run = await seedRun(h, { lifecycle: "PLANNING" });
    await executeRunJob(h.deps(createFakeStages({ blockAll: true })), run.id);
    const after = await new RunRepository(h.tdb.db).getById(run.id);
    expect(after.verdict).toBe("BLOCKED");
    expect(await lifecycleTrail(run.id)).toEqual(["PLANNING", "GENERATING_REPORT", "COMPLETED"]);
    const results = await new ResultRepository(h.tdb.db).listByRun(run.id);
    expect(results.map((r) => [r.status, r.reason])).toEqual([
      ["BLOCKED", "MISSING_SECRET"],
      ["BLOCKED", "MISSING_SECRET"],
    ]);
  });

  it("skips runs that are not PLANNING", async () => {
    const run = await seedRun(h, { lifecycle: "AWAITING_CONFIRMATION" });
    await executeRunJob(h.deps(createFakeStages()), run.id);
    expect((await new RunRepository(h.tdb.db).getById(run.id)).lifecycle).toBe("AWAITING_CONFIRMATION");
  });
});

describe("execute-run cancellation, errors, deadlines", () => {
  it("cancel signal between exploration steps → CANCELLED, browser closed once, run.cancelled published", async () => {
    const run = await seedRun(h, { lifecycle: "PLANNING", secrets: { password: "pw-123456" } });
    const stages = createFakeStages({
      explorationSteps: 50,
      stepDelayMs: 5,
      onStep: async (i) => {
        if (i === 2) await requestCancel(h, run.id);
      },
    });
    const deps = h.deps(stages);
    deps.config.timeScale = 1; // plenty of budget; cancellation must be what stops it
    await executeRunJob(deps, run.id);
    const after = await new RunRepository(h.tdb.db).getById(run.id);
    expect(after.lifecycle).toBe("CANCELLED");
    expect(after.cancelReason).toBe("USER_REQUESTED");
    expect(stages.browsers).toHaveLength(1);
    expect(stages.browsers[0]!.closeCount).toBe(1);
    const events = await eventsOf(h, run.id);
    expect(events.at(-1)!.type).toBe("run.cancelled");
    expect(events.at(-1)!.stage).toBe("CANCELLED");
    expect(await new SecretRepository(h.tdb.db).listActive(run.id)).toHaveLength(0);
  });

  it("notices a persisted cancel request at a step boundary even without the Redis signal", async () => {
    const run = await seedRun(h, { lifecycle: "PLANNING" });
    const stages = createFakeStages({
      explorationSteps: 50,
      onStep: async (i) => {
        if (i === 1) await requestCancel(h, run.id, false);
      },
    });
    const deps = h.deps(stages);
    deps.config.timeScale = 1;
    await executeRunJob(deps, run.id);
    expect((await new RunRepository(h.tdb.db).getById(run.id)).lifecycle).toBe("CANCELLED");
    expect(stages.browsers[0]!.closeCount).toBe(1);
  });

  it("planner ModelProviderError → ERRORED / MODEL_PROVIDER, no FAIL results", async () => {
    const run = await seedRun(h, { lifecycle: "PLANNING", secrets: { password: "pw-123456" } });
    await executeRunJob(h.deps(createFakeStages({ failAt: { stage: "plan", error: new ModelProviderError("upstream 529") } })), run.id);
    const after = await new RunRepository(h.tdb.db).getById(run.id);
    expect(after.lifecycle).toBe("ERRORED");
    expect(after.errorCategory).toBe("MODEL_PROVIDER");
    expect(after.verdict).toBeNull();
    const events = await eventsOf(h, run.id);
    expect(events.at(-1)).toMatchObject({ type: "run.errored", payload: { category: "MODEL_PROVIDER" } });
    const results = await new ResultRepository(h.tdb.db).listByRun(run.id);
    expect(results.filter((r) => r.status === "FAIL")).toHaveLength(0);
    expect(await new SecretRepository(h.tdb.db).listActive(run.id)).toHaveLength(0);
  });

  it("unknown errors become ERRORED / INTERNAL", async () => {
    const run = await seedRun(h, { lifecycle: "PLANNING" });
    await executeRunJob(h.deps(createFakeStages({ failAt: { stage: "verify", error: new TypeError("oops") } })), run.id);
    expect((await new RunRepository(h.tdb.db).getById(run.id)).errorCategory).toBe("INTERNAL");
  });

  it("hard deadline during exploration → ERRORED / TIMEOUT and the browser is closed", async () => {
    const run = await seedRun(h, { lifecycle: "PLANNING", secrets: { password: "pw-123456" } });
    // total budget = 60 s × 0.01 = 600 ms; the explorer ignores its budget and overruns.
    const stages = createFakeStages({ explorationSteps: 1000, stepDelayMs: 50, ignoreBudget: true });
    await executeRunJob(h.deps(stages), run.id);
    const after = await new RunRepository(h.tdb.db).getById(run.id);
    expect(after.lifecycle).toBe("ERRORED");
    expect(after.errorCategory).toBe("TIMEOUT");
    expect(stages.browsers[0]!.closeCount).toBe(1);
    expect(await new SecretRepository(h.tdb.db).listActive(run.id)).toHaveLength(0);
  });

  it("a stage that ignores the signal can't outlive the hard deadline (report overruns → TIMEOUT)", async () => {
    const run = await seedRun(h, { lifecycle: "PLANNING" });
    // total budget 600 ms; the report stage blocks for 1.2 s without looking at the signal.
    await executeRunJob(h.deps(createFakeStages({ explorationSteps: 1, stuckMs: { report: 1200 } })), run.id);
    const after = await new RunRepository(h.tdb.db).getById(run.id);
    expect(after.lifecycle).toBe("ERRORED");
    expect(after.errorCategory).toBe("TIMEOUT");
    expect(after.verdict).toBeNull();
  });

  it("does not start planning for a run already marked for cancellation", async () => {
    const run = await seedRun(h, { lifecycle: "PLANNING" });
    await requestCancel(h, run.id, false);
    let planned = 0;
    await executeRunJob(h.deps(createFakeStages({ onStage: (s) => void (s === "plan" && planned++) })), run.id);
    expect(planned).toBe(0);
    expect((await new RunRepository(h.tdb.db).getById(run.id)).lifecycle).toBe("CANCELLED");
  });

  it("errors the run (instead of leaving it stuck) when the context can't be built", async () => {
    const run = await seedRun(h, { lifecycle: "PLANNING" });
    // A secret encrypted with a different key can't be decrypted.
    await new SecretRepository(h.tdb.db).insertMany(run.id, [
      { name: "password", ...encryptSecret("pw-123456", { runId: run.id, name: "password" }, Buffer.alloc(32, 1)) },
    ]);
    await executeRunJob(h.deps(createFakeStages()), run.id);
    const after = await new RunRepository(h.tdb.db).getById(run.id);
    expect(after.lifecycle).toBe("ERRORED");
    expect(after.errorCategory).toBe("INTERNAL");
    expect((await eventsOf(h, run.id)).at(-1)!.type).toBe("run.errored");
    expect(await new SecretRepository(h.tdb.db).listActive(run.id)).toHaveLength(0);
  });

  it("exploration budget exhausted → continues to VERIFYING (not an error)", async () => {
    const run = await seedRun(h, { lifecycle: "PLANNING" });
    const stages = createFakeStages({ exploreUntilBudget: true, stepDelayMs: 20 });
    await executeRunJob(h.deps(stages), run.id);
    const after = await new RunRepository(h.tdb.db).getById(run.id);
    expect(after.lifecycle).toBe("COMPLETED");
    expect(after.verdict).toBe("INCONCLUSIVE");
    const results = await new ResultRepository(h.tdb.db).listByRun(run.id);
    expect(results.map((r) => r.reason)).toEqual(["EXPLORATION_BUDGET_EXHAUSTED", "EXPLORATION_BUDGET_EXHAUSTED"]);
    expect(await lifecycleTrail(run.id)).toContain("VERIFYING");
  });

  it("stops quietly when the reaper already ended the run (lost CAS race)", async () => {
    const run = await seedRun(h, { lifecycle: "PLANNING" });
    const stages = createFakeStages({
      explorationSteps: 3,
      onStep: async (i) => {
        if (i === 1) {
          await new RunRepository(h.tdb.db).transition(run.id, "EXPLORING", "ERRORED", { errorCategory: "WORKER_LOST" });
        }
      },
    });
    await executeRunJob(h.deps(stages), run.id);
    const after = await new RunRepository(h.tdb.db).getById(run.id);
    expect(after.lifecycle).toBe("ERRORED");
    expect(after.errorCategory).toBe("WORKER_LOST");
    const events = await new EventRepository(h.tdb.db).listAfter(run.id, 0, 1000);
    expect(events.filter((e) => e.type === "run.errored" || e.type === "run.completed")).toHaveLength(0);
  });
});
