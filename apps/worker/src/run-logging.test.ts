import { createLogger, createRunLogRegistry } from "@platform/config";
import { TEST_TENANT_ID } from "@platform/db/testing";
import type { EngineStages } from "@platform/testing-engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeRunJob } from "./jobs/execute-run";
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
});
