import { createLogger, createRunLogRegistry } from "@platform/config";
import { SecretRepository } from "@platform/db";
import { TEST_TENANT_ID } from "@platform/db/testing";
import { encryptSecret } from "@platform/security";
import type { EngineStages } from "@platform/testing-engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkerDeps } from "./deps";
import { executeRunJob } from "./jobs/execute-run";
import { createRunContext } from "./run-context";
import { createFakeStages, createHarness, requestCancel, seedRun, type WorkerHarness } from "./test-support";

let h: WorkerHarness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => h?.close());

const SECRET = "pw-Run-Log-Secret-42";

function setup() {
  const lines: string[] = [];
  const runLogs = createRunLogRegistry();
  const logger = createLogger({ component: "worker", runs: runLogs, write: (l) => void lines.push(l) });
  const parsed = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  return { lines, runLogs, logger, parsed };
}

/** Fake stages whose explore logs the run's secret the way a failing browser launch would. */
function leakyStages(logger: ReturnType<typeof createLogger>, extra: Partial<EngineStages> = {}): EngineStages {
  const fake = createFakeStages({ stepDelayMs: 0, explorationSteps: 2 });
  return {
    ...fake,
    explore: async (ctx, ...rest) => {
      logger.error({ runId: ctx.runId, err: new Error(`launch failed for ${SECRET}`) }, "browser sandbox failed to start");
      return fake.explore(ctx, ...rest);
    },
    ...extra,
  };
}

describe("run log lines (Task 22 step 2)", () => {
  it("carry runId, tenantId, the current stage and component; the run's secret value is redacted; the registry is empty afterwards", async () => {
    const { lines, runLogs, logger, parsed } = setup();
    const run = await seedRun(h, { lifecycle: "PLANNING", options: { maxRunSeconds: 600 }, secrets: { password: SECRET } });

    await executeRunJob(h.deps(leakyStages(logger), { logger, runLogs }), run.id);

    expect(lines.join("\n")).not.toContain(SECRET);
    const launch = parsed().find((l) => l.msg === "browser sandbox failed to start")!;
    expect(launch).toMatchObject({
      level: "error",
      component: "worker",
      runId: run.id,
      tenantId: TEST_TENANT_ID,
      stage: "EXPLORING",
      err: { name: "Error", message: "launch failed for [REDACTED]" },
    });
    expect(parsed().find((l) => l.msg === "run completed")).toMatchObject({ runId: run.id, tenantId: TEST_TENANT_ID, stage: "COMPLETED" });
    expect(runLogs.size).toBe(0);
  });

  it("a cancelled run also releases its registration", async () => {
    const { runLogs, logger, parsed } = setup();
    const run = await seedRun(h, { lifecycle: "PLANNING", options: { maxRunSeconds: 600 } });
    const stages = leakyStages(logger, {
      explore: async (ctx) => {
        await requestCancel(h, ctx.runId);
        await new Promise((_, reject) => ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true }));
        throw new Error("unreachable");
      },
    });

    await executeRunJob(h.deps(stages, { logger, runLogs }), run.id);

    expect(parsed().find((l) => l.msg === "run cancelled")).toMatchObject({ runId: run.id, tenantId: TEST_TENANT_ID, stage: "CANCELLED" });
    expect(runLogs.size).toBe(0);
  });

  it("an ERRORED run's line carries the error's stack and cause, with the run's secret redacted", async () => {
    const { lines, runLogs, logger, parsed } = setup();
    const run = await seedRun(h, { lifecycle: "PLANNING", options: { maxRunSeconds: 600 }, secrets: { password: SECRET } });
    const stages = leakyStages(logger, {
      explore: async () => {
        throw new Error("browser crashed", { cause: new Error(`launch failed for ${SECRET}`) });
      },
    });

    await executeRunJob(h.deps(stages, { logger, runLogs }), run.id);

    expect(lines.join("\n")).not.toContain(SECRET);
    expect(parsed().find((l) => l.msg === "run errored")).toMatchObject({
      runId: run.id,
      tenantId: TEST_TENANT_ID,
      stage: "ERRORED",
      category: "INTERNAL",
      err: {
        message: "browser crashed",
        stack: expect.stringContaining("Error: browser crashed\n    at "),
        cause: { message: "launch failed for [REDACTED]", stack: expect.stringContaining("launch failed for [REDACTED]") },
      },
    });
  });

  it("dispose() still releases the registration, and drops the run's secrets, when a release before them throws", async () => {
    const { runLogs, logger } = setup();
    const run = await seedRun(h, { lifecycle: "PLANNING", options: { maxRunSeconds: 600 }, secrets: { password: SECRET } });
    const cancelWatcher = {
      watch: async () => () => {
        throw new Error("unwatch failed");
      },
    } as unknown as WorkerDeps["cancelWatcher"];
    const handle = await createRunContext(h.deps(createFakeStages(), { logger, runLogs, cancelWatcher }), run, {
      deadlineAt: new Date(Date.now() + 60_000),
      totalBudgetMs: 60_000,
    });
    expect(runLogs.get(run.id)).toBeDefined();
    expect(handle.ctx.secrets.get("password")).toBe(SECRET);

    await expect(handle.dispose()).rejects.toThrow("unwatch failed");

    expect(runLogs.size).toBe(0);
    expect(handle.ctx.secrets.get("password")).toBeUndefined();
  });

  it("a run the worker cannot start (secrets fail to decrypt) logs with tenantId and stage too", async () => {
    const { logger, parsed, runLogs } = setup();
    const run = await seedRun(h, { lifecycle: "PLANNING", options: { maxRunSeconds: 600 } });
    // Encrypted with another key: the run context cannot be built.
    await new SecretRepository(h.tdb.db).insertMany(run.id, [
      { name: "password", ...encryptSecret(SECRET, { runId: run.id, name: "password" }, Buffer.alloc(32, 7)) },
    ]);

    await executeRunJob(h.deps(createFakeStages(), { logger, runLogs }), run.id);

    expect(parsed().find((l) => l.msg === "Run could not be started by the worker")).toMatchObject({
      runId: run.id,
      tenantId: TEST_TENANT_ID,
      stage: "PLANNING",
      err: { name: "Error", stack: expect.stringContaining("\n    at ") },
    });
  });

  it("a skipped job's line carries tenantId and the run's current stage", async () => {
    const { logger, parsed, runLogs } = setup();
    const run = await seedRun(h, { lifecycle: "AWAITING_CONFIRMATION" });

    await executeRunJob(h.deps(createFakeStages(), { logger, runLogs }), run.id);

    expect(parsed().find((l) => l.msg === "execute-run skipped: run is not PLANNING")).toMatchObject({
      runId: run.id,
      tenantId: TEST_TENANT_ID,
      stage: "AWAITING_CONFIRMATION",
    });
  });
});
