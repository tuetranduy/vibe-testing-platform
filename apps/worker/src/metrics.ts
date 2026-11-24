import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { LlmCallRecord } from "@platform/llm";
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import type { EgressBlockEvent } from "./sandbox/egress-proxy";

/** `verdict` label of runs that ended without one (ERRORED, CANCELLED). */
export const NO_VERDICT = "none";

/** `test_run_duration_seconds` buckets; the API's histogram uses the same, since Prometheus sums the two. */
export const RUN_DURATION_BUCKETS = [1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600];

const MIB = 1024 ** 2;
/** Up to the agent container's 2 GiB limit; 1.8 GiB (90 %) is the alert's near-limit boundary. */
export const DISCOVERY_MEMORY_BUCKETS = [64 * MIB, 128 * MIB, 256 * MIB, 512 * MIB, 768 * MIB, 1024 * MIB, 1536 * MIB, 1932735283, 2048 * MIB];

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
    discoveryJobs: new Counter({
      name: "discovery_jobs_total",
      help: "Opted-in runs' Browser Use outcomes by status and reason (BUSY and BLOCKED never started a broker job)",
      labelNames: ["status", "reason"],
      registers,
    }),
    discoveryDuration: new Histogram({ name: "discovery_duration_seconds", help: "Elapsed time of attempted Browser Use jobs", buckets: RUN_DURATION_BUCKETS, registers }),
    discoveryCleanupErrors: new Counter({ name: "discovery_cancellation_cleanup_errors_total", help: "Abandoned Browser Use jobs whose cancellation the broker did not confirm", registers }),
    discoveryWorkerMemory: new Histogram({
      name: "discovery_worker_memory_bytes",
      help: "Peak memory of each attempted job's Browser Use agent container (Chromium, Browser Use and agent Python), "
        + "sampled on the trusted host with docker stats; the container's hard limit is 2 GiB",
      buckets: DISCOVERY_MEMORY_BUCKETS,
      registers,
    }),
    discoveryAdmissionWait: new Histogram({
      name: "discovery_admission_wait_seconds",
      help: "Time opted-in runs waited for a fair turn at the broker's job slots, by outcome",
      labelNames: ["outcome"],
      buckets: [0.1, 0.5, 1, 5, 15, 30, 60, 120],
      registers,
    }),
    discoveryBlockedDestinations: new Counter({
      name: "discovery_blocked_destinations_total",
      help: "Proxy mode: requests from Browser Use agent containers that the job's egress proxy refused, by reason",
      labelNames: ["reason"],
      registers,
    }),
    discoveryActiveJobs: new Gauge({
      name: "discovery_active_jobs",
      help: "Browser Use discovery calls in flight in this worker process (the broker itself runs one job at a time)",
      registers,
    }),
    discoverySelectedRuns: new Counter({
      name: "discovery_selected_runs_total",
      help: "Runs that executed a selected Browser Use suggestion, by terminal lifecycle, verdict and whether it was edited",
      labelNames: ["lifecycle", "verdict", "edited"],
      registers,
    }),
    discoveryProtocolViolations: new Counter({ name: "discovery_protocol_violations_total", help: "Malformed frames from Browser Use agent containers", registers }),
    discoveryFallback: new Counter({ name: "discovery_fallback_total", help: "Browser Use attempts using the standard survey fallback", registers }),
    discoveryCandidates: new Counter({ name: "discovery_candidates_total", help: "Returned and accepted Browser Use candidates", labelNames: ["kind"], registers }),
    discoverySteps: new Histogram({ name: "discovery_agent_steps", help: "Browser Use agent steps per run", buckets: [1, 2, 5, 10, 15, 20], registers }),
    discoveryCost: new Counter({ name: "discovery_model_cost_usd_total", help: "Known Browser Use model cost in USD", registers }),
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
