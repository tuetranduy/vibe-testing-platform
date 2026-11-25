import { RunLogRepository } from "@platform/db";
import { TEST_TENANT_ID } from "@platform/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkerLogging } from "./run-logging";
import { createWorkerMetrics } from "./metrics";
import { createHarness, seedRun, type WorkerHarness } from "./test-support";

let h: WorkerHarness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => h?.close());

describe("createWorkerLogging", () => {
  it("stores a run's lines with their source; lines without a run stay on stdout only", async () => {
    const run = await seedRun(h);
    const stdout: string[] = [];
    const logging = createWorkerLogging({ level: "info", maxLinesPerRun: 100, metrics: createWorkerMetrics(), write: (l) => void stdout.push(l) });
    logging.attachDb(h.tdb.db);
    logging.logger.info({ runId: run.id, step: 1 }, "step done");
    logging.logger.warn({ runId: run.id, source: "infra" }, "egress blocked");
    logging.logger.info({}, "worker started");
    await logging.sink.flush();
    const page = await new RunLogRepository(h.tdb.db).list(TEST_TENANT_ID, run.id, { limit: 10 });
    expect(page.lines.map((l) => [l.source, l.level, l.message])).toEqual([
      ["worker", "info", "step done"],
      ["infra", "warn", "egress blocked"],
    ]);
    expect(stdout).toHaveLength(3);
    await logging.sink.close();
  });

  it("lines before the database is attached are dropped, not thrown", async () => {
    const run = await seedRun(h);
    const logging = createWorkerLogging({ level: "info", maxLinesPerRun: 100, metrics: createWorkerMetrics(), write: () => {} });
    expect(() => logging.logger.info({ runId: run.id }, "early")).not.toThrow();
    await logging.sink.flush();
    logging.attachDb(h.tdb.db);
    expect(await new RunLogRepository(h.tdb.db).count(run.id)).toBe(0);
    await logging.sink.close();
  });

  it("counts dropped lines in run_log_dropped_total", async () => {
    const metrics = createWorkerMetrics();
    const logging = createWorkerLogging({ level: "info", maxLinesPerRun: 1, metrics, write: () => {} });
    logging.attachDb(h.tdb.db);
    logging.logger.info({ runId: "run_x" }, "a");
    logging.logger.info({ runId: "run_x" }, "b");
    await logging.sink.close();
    const dropped = await metrics.runLogDropped.get();
    expect(dropped.values.find((v) => v.labels.reason === "cap")?.value).toBe(1);
  });
});
