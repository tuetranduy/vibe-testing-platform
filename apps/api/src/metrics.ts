import type { RunQueue } from "@platform/event-bus";
import { Counter, Gauge, Registry, collectDefaultMetrics } from "prom-client";

/** `verdict` label of runs that ended without one. */
export const NO_VERDICT = "none";

/** How long a scrape waits for the queue depth. */
const QUEUE_DEPTH_TIMEOUT_MS = 1_000;

/** The value, or undefined when it rejects or takes longer than `ms`. */
async function within<T>(promise: Promise<T> | undefined, ms: number): Promise<T | undefined> {
  if (!promise) return undefined;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([promise.catch(() => undefined), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The API's Prometheus metrics: `queue_depth` (read from Redis at scrape time; the series is
 * dropped for that scrape when Redis cannot answer in time — the queue's connection holds commands
 * while Redis reconnects, so waiting would hang the whole scrape — and one outage never hides the
 * rest) and the runs the API ends itself (cancel before a worker holds them, enqueue failures).
 */
export function createApiMetrics(opts: { queue?: Pick<RunQueue, "depth">; depthTimeoutMs?: number } = {}) {
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
      const depth = await within(opts.queue?.depth?.(), opts.depthTimeoutMs ?? QUEUE_DEPTH_TIMEOUT_MS);
      if (depth !== undefined) this.set({ queue: "runs" }, depth);
    },
  });
  return {
    registry,
    testRuns: new Counter({ name: "test_runs_total", help: "Runs that reached a terminal lifecycle", labelNames: ["lifecycle", "verdict"], registers }),
  };
}

export type ApiMetrics = ReturnType<typeof createApiMetrics>;
