import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { LlmCallRecord } from "@platform/llm";
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import type { EgressBlockEvent } from "./sandbox/egress-proxy";

/** `verdict` label of runs that ended without one (ERRORED, CANCELLED). */
export const NO_VERDICT = "none";

/** `test_run_duration_seconds` buckets; the API's histogram uses the same, since Prometheus sums the two. */
export const RUN_DURATION_BUCKETS = [1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600];

/**
 * The worker's Prometheus metrics (Task 22). One registry per process; the API exports
 * `queue_depth` and its own `test_runs_total` series (runs it ends itself), which Prometheus sums.
 */
export function createWorkerMetrics(registry = new Registry()) {
  collectDefaultMetrics({ register: registry });
  const registers = [registry];
  return {
    registry,
    testRuns: new Counter({ name: "test_runs_total", help: "Runs that reached a terminal lifecycle", labelNames: ["lifecycle", "verdict"], registers }),
    runDuration: new Histogram({
      name: "test_run_duration_seconds",
      help: "Time a run spent in each lifecycle stage",
      labelNames: ["stage"],
      buckets: RUN_DURATION_BUCKETS,
      registers,
    }),
    activeRuns: new Gauge({ name: "active_worker_runs", help: "Run jobs (analyze / execute) this worker is processing", registers }),
    browserSessions: new Gauge({ name: "browser_sessions_active", help: "Open sandboxed browsers (exploration) and rerun runner processes", registers }),
    llmRequests: new Counter({ name: "llm_requests_total", help: "Model calls", labelNames: ["stage", "model", "status"], registers }),
    llmTokens: new Counter({ name: "llm_tokens_total", help: "Model tokens", labelNames: ["stage", "model", "direction"], registers }),
    llmCost: new Counter({ name: "llm_cost_usd_total", help: "Estimated model cost in USD", labelNames: ["stage", "model"], registers }),
    stagehandCacheHits: new Counter({ name: "stagehand_cache_hits_total", help: "Exploration steps Stagehand served from its cache", registers }),
    egressBlocked: new Counter({ name: "egress_blocked_total", help: "Connections the egress proxy denied", labelNames: ["reason"], registers }),
    reconciliationDisagreements: new Counter({
      name: "reconciliation_disagreements_total",
      help: "Criteria whose discovery result and Playwright rerun disagreed",
      registers,
    }),
    runsReaped: new Counter({ name: "runs_reaped_total", help: "Runs the reaper ended", labelNames: ["reason"], registers }),
    artifactUploadFailures: new Counter({ name: "artifact_upload_failures_total", help: "Artifact uploads that failed", registers }),
  };
}

export type WorkerMetrics = ReturnType<typeof createWorkerMetrics>;

/**
 * Observes the time a run spent in `stage`, which it entered at `enteredAt` (its
 * `lifecycleChangedAt`) and leaves at `leftAt`. Every transition times the stage it ends,
 * whichever process makes it.
 */
export function observeStage(metrics: WorkerMetrics | undefined, stage: string, enteredAt: Date, leftAt: Date): void {
  metrics?.runDuration.observe({ stage }, Math.max(0, leftAt.getTime() - enteredAt.getTime()) / 1000);
}

/** The LlmClient's call sink, next to the llm_calls row. */
export function recordLlmCall(metrics: WorkerMetrics, call: LlmCallRecord): void {
  const { stage, model } = call;
  metrics.llmRequests.inc({ stage, model, status: call.status });
  if (call.inputTokens > 0) metrics.llmTokens.inc({ stage, model, direction: "input" }, call.inputTokens);
  if (call.outputTokens > 0) metrics.llmTokens.inc({ stage, model, direction: "output" }, call.outputTokens);
  if (call.estimatedCostUsd > 0) metrics.llmCost.inc({ stage, model }, call.estimatedCostUsd);
}

/** Egress proxy `onBlock` tap. Chromium's own background services are not the site's doing (same rule as the events). */
export function countEgressBlock(metrics: WorkerMetrics | undefined): (e: EgressBlockEvent) => void {
  return (e) => {
    if (e.reason !== "BACKGROUND_SERVICE_DENIED") metrics?.egressBlocked.inc({ reason: e.reason });
  };
}

/** `GET /metrics` on its own port, separate from anything the sandboxed browser is given. */
export async function startMetricsServer(registry: Registry, port: number, host = "0.0.0.0"): Promise<{ port: number; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    if (req.method !== "GET" || req.url?.split("?")[0] !== "/metrics") {
      res.writeHead(404).end();
      return;
    }
    registry.metrics().then(
      (body) => res.writeHead(200, { "content-type": registry.contentType }).end(body),
      () => res.writeHead(500).end(),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
