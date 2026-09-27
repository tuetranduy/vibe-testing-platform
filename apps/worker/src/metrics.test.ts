import { TEST_TENANT_ID } from "@platform/db/testing";
import type { ArtifactStorage } from "@platform/storage";
import type { Counter, Gauge, Histogram } from "prom-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { storeArtifact } from "./artifacts";
import { executeRunJob } from "./jobs/execute-run";
import { reapJob } from "./jobs/reap";
import { countEgressBlock, createWorkerMetrics, recordLlmCall, startMetricsServer, type WorkerMetrics } from "./metrics";
import { createFakeStages, createHarness, seedRun, type WorkerHarness } from "./test-support";

let h: WorkerHarness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => h?.close());

/** The value of one labelled series (0 when absent). */
async function value(metric: Counter<string> | Gauge<string>, labels: Record<string, string> = {}): Promise<number> {
  const { values } = await metric.get();
  const hit = values.find((v) => Object.entries(labels).every(([k, want]) => v.labels[k] === want));
  return hit?.value ?? 0;
}
async function observations(metric: Histogram<string>, labels: Record<string, string>): Promise<number> {
  const { values } = await metric.get();
  return values.find((v) => v.metricName?.endsWith("_count") && Object.entries(labels).every(([k, w]) => v.labels[k] === w))?.value ?? 0;
}

describe("worker metrics", () => {
  it("recordLlmCall counts requests, tokens by direction and cost", async () => {
    const m = createWorkerMetrics();
    const call = {
      runId: "run_1",
      stage: "PLANNING",
      provider: "anthropic",
      model: "claude-sonnet-5",
      inputTokens: 1200,
      outputTokens: 300,
      estimatedCostUsd: 0.0081,
      latencyMs: 900,
      status: "SUCCESS",
    } as const;
    recordLlmCall(m, call);
    recordLlmCall(m, { ...call, status: "PROVIDER_ERROR", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 });
    expect(await value(m.llmRequests, { stage: "PLANNING", model: "claude-sonnet-5", status: "SUCCESS" })).toBe(1);
    expect(await value(m.llmRequests, { stage: "PLANNING", model: "claude-sonnet-5", status: "PROVIDER_ERROR" })).toBe(1);
    expect(await value(m.llmTokens, { stage: "PLANNING", model: "claude-sonnet-5", direction: "input" })).toBe(1200);
    expect(await value(m.llmTokens, { stage: "PLANNING", model: "claude-sonnet-5", direction: "output" })).toBe(300);
    expect(await value(m.llmCost, { stage: "PLANNING", model: "claude-sonnet-5" })).toBeCloseTo(0.0081);
  });

  it("countEgressBlock counts by reason and ignores Chromium's own background services", async () => {
    const m = createWorkerMetrics();
    const count = countEgressBlock(m);
    count({ host: "169.254.169.254", port: 80, reason: "NON_PUBLIC_ADDRESS" });
    count({ host: "update.googleapis.com", port: 443, reason: "BACKGROUND_SERVICE_DENIED" });
    expect(await value(m.egressBlocked, { reason: "NON_PUBLIC_ADDRESS" })).toBe(1);
    expect(await value(m.egressBlocked, { reason: "BACKGROUND_SERVICE_DENIED" })).toBe(0);
  });

  it("an executed run counts as test_runs_total{lifecycle,verdict}, observes each stage's duration, and leaves no active run", async () => {
    const m = createWorkerMetrics();
    const run = await seedRun(h, { lifecycle: "PLANNING", options: { maxRunSeconds: 600 } });
    await executeRunJob(h.deps(createFakeStages({ stepDelayMs: 0, explorationSteps: 2 }), { metrics: m }), run.id);

    const { values } = await m.testRuns.get();
    expect(values).toEqual([expect.objectContaining({ value: 1, labels: { lifecycle: "COMPLETED", verdict: expect.stringMatching(/^[A-Z]+$/) } })]);
    for (const stage of ["PLANNING", "EXPLORING", "VERIFYING", "GENERATING_REPORT"]) {
      expect(await observations(m.runDuration, { stage })).toBe(1);
    }
    expect(await value(m.activeRuns)).toBe(0);
  });

  it("the reaper counts what it reaped, by reason, and the runs it ended", async () => {
    const m = createWorkerMetrics();
    await seedRun(h, { lifecycle: "AWAITING_CONFIRMATION" });
    const later = new Date(Date.now() + 25 * 3_600_000);
    await reapJob(h.deps(createFakeStages(), { metrics: m, now: () => later }));
    expect(await value(m.runsReaped, { reason: "CONFIRMATION_EXPIRED" })).toBeGreaterThanOrEqual(1);
    expect(await value(m.testRuns, { lifecycle: "CANCELLED", verdict: "none" })).toBeGreaterThanOrEqual(1);
  });

  it("a failed artifact upload is counted and still thrown", async () => {
    const m = createWorkerMetrics();
    const broken = { put: async () => Promise.reject(new Error("s3 down")) } as unknown as ArtifactStorage;
    const input = {
      tenantId: TEST_TENANT_ID,
      runId: "run_x",
      type: "SCREENSHOT",
      fileName: "a.png",
      body: Buffer.from("x"),
      contentType: "image/png",
      sensitivity: "STANDARD",
    } as const;
    await expect(
      storeArtifact({ db: h.tdb.db, storage: broken, config: { artifactRetentionDays: 30, secretArtifactRetentionDays: 7 }, metrics: m }, input),
    ).rejects.toThrow("s3 down");
    expect(await value(m.artifactUploadFailures)).toBe(1);
  });

  it("startMetricsServer serves the registry at /metrics (and nothing else)", async () => {
    const m: WorkerMetrics = createWorkerMetrics();
    const server = await startMetricsServer(m.registry, 0, "127.0.0.1");
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/metrics`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/plain");
      const text = await res.text();
      for (const name of [
        "test_runs_total",
        "test_run_duration_seconds",
        "active_worker_runs",
        "browser_sessions_active",
        "llm_requests_total",
        "llm_tokens_total",
        "llm_cost_usd_total",
        "stagehand_cache_hits_total",
        "egress_blocked_total",
        "reconciliation_disagreements_total",
        "runs_reaped_total",
        "artifact_upload_failures_total",
      ]) {
        expect(text).toContain(`# TYPE ${name} `);
      }
      expect((await fetch(`http://127.0.0.1:${server.port}/other`)).status).toBe(404);
    } finally {
      await server.close();
    }
  });
});
