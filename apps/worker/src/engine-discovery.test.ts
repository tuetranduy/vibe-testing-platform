import { RunOptionsSchema, SuggestionSetDraftSchema, type SuggestionSetDraft } from "@platform/contracts";
import { withAutonomousDiscovery, type StageContext } from "@platform/testing-engine";
import { Registry } from "prom-client";
import { describe, expect, it, vi } from "vitest";
import { createDiscoveryDeps } from "./engine";
import { createWorkerMetrics } from "./metrics";

const fixtureUrl = "http://127.0.0.1:4599/";
const draft = SuggestionSetDraftSchema.parse({ pages: [{ url: fixtureUrl, title: "Fixture", status: "READ" }], suggestions: [{
  id: "S-1", title: "Open the catalog", requirement: "A visitor can open the catalog.", why: "Seen.",
  needs: { secrets: [], testData: [] }, destructive: false,
}] });
const survey = async (): Promise<SuggestionSetDraft> => draft;
const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return logger; } } as never;

function context(): StageContext {
  return {
    runId: "run_engine", tenantId: "t_default",
    request: {
      targetUrl: fixtureUrl, environment: "staging", requirement: "", browser: "chromium", testData: {}, secretNames: [],
      options: RunOptionsSchema.parse({ autonomousDiscovery: true }),
    },
    deadlineAt: new Date(Date.now() + 180_000), now: () => new Date(),
    signal: new AbortController().signal,
    budgetSignal: (ms: number) => AbortSignal.timeout(ms),
    boundary: async () => {}, redact: (value: unknown) => value, publish: vi.fn(async () => {}),
    budgets: { explorationMs: 1, rerunMs: 1 }, secrets: { names: [], get: () => undefined }, addCleanup: () => {}, llm: null,
  } as StageContext;
}

const metricValue = async (registry: Registry, name: string) => (await registry.getSingleMetric(name)?.get())?.values ?? [];

describe("the worker's Browser Use wiring", () => {
  it("records an admitted run as BLOCKED / not_configured on a worker without a transport, without a duration", async () => {
    const registry = new Registry();
    const metrics = createWorkerMetrics(registry);
    // Admission (the non-secret fixture URL) without any transport: the API could admit, this worker cannot run it.
    const deps = createDiscoveryDeps({ BROWSER_USE_DISCOVERY_FIXTURE_URL: fixtureUrl, DEFAULT_TENANT_ID: "t_default" }, { logger, metrics });
    expect(deps.port).toBeUndefined();
    const ctx = context();
    await expect(withAutonomousDiscovery(survey, deps)(ctx)).resolves.toBe(draft);
    expect(vi.mocked(ctx.publish).mock.calls.map(([event]) => event.type)).toEqual(["discovery.failed"]);
    expect(await metricValue(registry, "discovery_jobs_total")).toEqual([
      expect.objectContaining({ value: 1, labels: { status: "BLOCKED", reason: "not_configured" } }),
    ]);
    // Only attempted jobs are timed: the histogram stays empty.
    const durations = (await metricValue(registry, "discovery_duration_seconds")) as { metricName?: string; value: number }[];
    expect(durations.find((sample) => sample.metricName === "discovery_duration_seconds_count")?.value).toBe(0);
  });

  it("closes admission without the tenant flag, even with a transport configured", async () => {
    const registry = new Registry();
    const metrics = createWorkerMetrics(registry);
    const redis = { get: vi.fn(async () => null), eval: vi.fn(async () => 1) };
    const deps = createDiscoveryDeps({
      BROWSER_USE_DISCOVERY_FIXTURE_URL: fixtureUrl, DEFAULT_TENANT_ID: "t_default",
      BROWSER_USE_DISCOVERY_SERVICE_URL: "http://127.0.0.1:4600", BROWSER_USE_DISCOVERY_SERVICE_TOKEN: "x".repeat(32),
    }, { logger, metrics, discoveryRollout: redis });
    expect(deps.port).toBeDefined();
    const ctx = context();
    await withAutonomousDiscovery(survey, deps)(ctx);
    expect(redis.eval).not.toHaveBeenCalled(); // a disabled tenant spends no quota
    expect(await metricValue(registry, "discovery_jobs_total")).toEqual([
      expect.objectContaining({ labels: { status: "BLOCKED", reason: "tenant_disabled" } }),
    ]);
  });

  it("counts an exhausted tenant quota as BUSY, which the failure alert excludes", async () => {
    const registry = new Registry();
    const metrics = createWorkerMetrics(registry);
    const redis = { get: vi.fn(async () => "1"), eval: vi.fn(async () => 99) };
    const deps = createDiscoveryDeps({
      BROWSER_USE_DISCOVERY_FIXTURE_URL: fixtureUrl, DEFAULT_TENANT_ID: "t_default",
      BROWSER_USE_DISCOVERY_SERVICE_URL: "http://127.0.0.1:4600", BROWSER_USE_DISCOVERY_SERVICE_TOKEN: "x".repeat(32),
      BROWSER_USE_DISCOVERY_TENANT_HOURLY_LIMIT: 20,
    }, { logger, metrics, discoveryRollout: redis });
    await withAutonomousDiscovery(survey, deps)(context());
    expect(await metricValue(registry, "discovery_jobs_total")).toEqual([
      expect.objectContaining({ labels: { status: "BUSY", reason: "tenant_quota" } }),
    ]);
  });

  it("records the agent container's peak memory and counts in-flight calls only while a job runs", async () => {
    const registry = new Registry();
    const metrics = createWorkerMetrics(registry);
    const redis = { get: vi.fn(async () => "1"), eval: vi.fn(async () => 1) };
    const deps = createDiscoveryDeps({
      BROWSER_USE_DISCOVERY_FIXTURE_URL: fixtureUrl, DEFAULT_TENANT_ID: "t_default",
      BROWSER_USE_DISCOVERY_SERVICE_URL: "http://127.0.0.1:4600", BROWSER_USE_DISCOVERY_SERVICE_TOKEN: "x".repeat(32),
    }, { logger, metrics, discoveryRollout: redis });
    const active = async () => (await metricValue(registry, "discovery_active_jobs"))[0]?.value;
    let during: number | undefined;
    vi.stubGlobal("fetch", vi.fn(async () => {
      during = await active();
      return Response.json({ jobId: "run_engine", agentSteps: 2, result: {
        schemaVersion: "discovery.v1", runId: "run_engine", status: "PARTIAL", reason: "no_valid_candidates", candidates: [],
        statistics: { agentSteps: 2, modelRequests: 2, durationMs: 4000, inputTokens: 0, outputTokens: 0, modelCostUsd: 0, protocolViolations: 0, peakMemoryBytes: 600 * 1024 ** 2,
          blockedDestinations: 5, blockedByReason: { not_allowlisted: 2, connect_denied: 3 } },
      } }, { status: 202 });
    }));
    try {
      await withAutonomousDiscovery(survey, deps)(context());
    } finally {
      vi.unstubAllGlobals();
    }
    expect(during).toBe(1);
    expect(await active()).toBe(0);
    const memory = (await metricValue(registry, "discovery_worker_memory_bytes")) as { metricName?: string; value: number; labels: { le?: number | string } }[];
    expect(memory.find((sample) => sample.metricName === "discovery_worker_memory_bytes_count")?.value).toBe(1);
    expect(memory.find((sample) => sample.metricName === "discovery_worker_memory_bytes_bucket" && sample.labels.le === 768 * 1024 ** 2)?.value).toBe(1);
    expect(memory.find((sample) => sample.metricName === "discovery_worker_memory_bytes_bucket" && sample.labels.le === 512 * 1024 ** 2)?.value).toBe(0);
    expect(await metricValue(registry, "discovery_blocked_destinations_total")).toEqual([
      expect.objectContaining({ value: 2, labels: { reason: "not_allowlisted" } }),
      expect.objectContaining({ value: 3, labels: { reason: "connect_denied" } }),
    ]);
  });
});
