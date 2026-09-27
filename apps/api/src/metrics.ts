import type { RunQueue } from "@platform/event-bus";
import { Counter, Gauge, Registry, collectDefaultMetrics } from "prom-client";

/** `verdict` label of runs that ended without one. */
export const NO_VERDICT = "none";

/**
 * The API's Prometheus metrics: `queue_depth` (read from Redis at scrape time; the series is
 * dropped for that scrape when Redis cannot answer, so one outage never hides the rest) and the
 * runs the API ends itself (cancel before a worker holds them, enqueue failures).
 */
export function createApiMetrics(opts: { queue?: Pick<RunQueue, "depth"> } = {}) {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  const registers = [registry];
  new Gauge({
    name: "queue_depth",
    help: "Jobs waiting in a queue",
    labelNames: ["queue"],
    registers,
    async collect() {
      this.reset();
      const depth = await opts.queue?.depth?.().catch(() => undefined);
      if (depth !== undefined) this.set({ queue: "runs" }, depth);
    },
  });
  return {
    registry,
    testRuns: new Counter({ name: "test_runs_total", help: "Runs that reached a terminal lifecycle", labelNames: ["lifecycle", "verdict"], registers }),
  };
}

export type ApiMetrics = ReturnType<typeof createApiMetrics>;
