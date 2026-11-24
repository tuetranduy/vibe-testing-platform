import { SuggestionSetResponseSchema, TestReportSchema } from "@platform/contracts";
import { setRunQueuePaused } from "@platform/event-bus";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Redis } from "ioredis";
import { afterAll, expect, inject, it } from "vitest";
import { api, db } from "./support/client";
import { DISCOVERY_NAVIGATION_GOAL } from "./support/scenarios";

const stack = inject("e2e");
const client = api(stack);
const store = db(stack);
afterAll(() => store.close());

// CI sets this so a missing transport fails the job instead of silently skipping the discovery cases.
it.runIf(process.env.BROWSER_USE_DISCOVERY_E2E_REQUIRED === "1")("has the discovery fixture and transport configured", () => {
  expect(stack.discoveryFixtureUrl).toBeDefined();
});

it.runIf(Boolean(stack.discoveryFixtureUrl))("executes an unedited Browser Use suggestion and verifies it with Playwright", async () => {
  const url = stack.discoveryFixtureUrl!;
  expect((await client.call("PUT", "/v1/settings/discovery", { enabled: true })).status).toBe(200);
  expect((await client.call("GET", "/v1/discovery/capability")).json).toEqual({ fixtureUrl: new URL(url).href });
  const runId = await client.create({
    targetUrl: url, environment: "staging",
    options: { autonomousDiscovery: true, discoveryMaxSteps: 10, discoveryMaxSeconds: 60 },
  });
  await client.waitFor(runId, (run) => run.lifecycle === "AWAITING_SELECTION");

  const set = SuggestionSetResponseSchema.parse((await client.suggestions(runId)).json);
  // The scripted Browser Use model's navigation idea, exactly as the merge offered it.
  const suggestion = set.suggestions.find((item) => item.discovery && item.requirement.startsWith(DISCOVERY_NAVIGATION_GOAL));
  expect(suggestion?.discovery?.engine).toBe("browser_use");
  const events = await store.events(runId);
  expect(events.some((event) => event.type === "discovery.started")).toBe(true);
  expect(events.some((event) => event.type === "discovery.progress")).toBe(true);
  expect(events.find((event) => event.type === "discovery.completed")?.payload).toMatchObject({
    status: "COMPLETED", reason: "ok", attempted: true, fallbackUsed: false, acceptedCount: expect.any(Number),
  });
  expect(JSON.stringify(events.filter((event) => event.type.startsWith("discovery.")))).not.toContain(suggestion!.requirement);

  // Unedited: the suggestion's own requirement goes to analysis, Stagehand and the Playwright rerun.
  expect((await client.select(runId, { suggestionId: suggestion!.id })).status).toBe(202);
  await client.waitFor(runId, (run) => run.lifecycle === "AWAITING_CONFIRMATION");
  expect((await client.confirm(runId)).status).toBe(202);
  expect(await client.finished(runId)).toMatchObject({ lifecycle: "COMPLETED", verdict: "PASSED" });
  const report = TestReportSchema.parse(await client.report(runId));
  expect(report.requirement?.originalText).toBe(suggestion!.requirement);
  expect(report.discovery).toMatchObject({
    status: "COMPLETED", fallbackUsed: false,
    selectedSuggestion: { id: suggestion!.id, edited: false, relevantPaths: suggestion!.discovery!.relevantPaths },
  });
  expect(report.playwright?.status).toBe("PASSED");
  expect(report.criteria[0]?.verdictSource).toBe("PLAYWRIGHT_RERUN");

  // Monitoring (plan §14.2) from the worker's Prometheus endpoint and the broker's health.
  const metrics = await (await fetch(stack.workerMetricsUrl)).text();
  const sample = (pattern: RegExp) => Number(pattern.exec(metrics)?.[1] ?? NaN);
  expect(sample(/^discovery_selected_runs_total\{lifecycle="COMPLETED",verdict="PASSED",edited="false"\} (\d+)$/m)).toBe(1);
  expect(sample(/^discovery_worker_memory_bytes_count (\d+)$/m)).toBeGreaterThanOrEqual(1);
  expect(sample(/^discovery_worker_memory_bytes_sum (\d+(?:\.\d+)?(?:e\+\d+)?)$/m)).toBeGreaterThan(16 * 1024 ** 2);
  expect(sample(/^discovery_active_jobs (\d+)$/m)).toBe(0);
  const broker = process.env.BROWSER_USE_DISCOVERY_SERVICE_URL;
  if (broker) expect(await (await fetch(`${broker}/internal/health`)).json()).toMatchObject({ status: "ready", activeJobs: 0, jobSlots: 1, cleanupFailures: 0 });
});

it.runIf(Boolean(stack.discoveryFixtureUrl))("rolls back deterministically: a queued opted-in run gets the standard survey", async () => {
  const url = stack.discoveryFixtureUrl!;
  const connection = new Redis(stack.redisUrl, { maxRetriesPerRequest: null });
  expect((await client.call("PUT", "/v1/settings/discovery", { enabled: true })).status).toBe(200);
  // Hold the run in the queue until the rollback is saved: no race with the worker's survey.
  await setRunQueuePaused(connection, true);
  let queued: string;
  try {
    queued = await client.create({ targetUrl: url, environment: "staging", options: { autonomousDiscovery: true } });
    expect((await client.call("PUT", "/v1/settings/discovery", { enabled: false })).json).toEqual({ available: true, enabled: false });
    expect((await client.call("GET", "/v1/discovery/capability")).json).toEqual({ fixtureUrl: null });
    expect((await client.call("POST", "/v1/test-runs", { targetUrl: url, options: { autonomousDiscovery: true } })).status).toBe(422);
  } finally {
    await setRunQueuePaused(connection, false);
    connection.disconnect();
  }
  await client.waitFor(queued, (run) => run.lifecycle === "AWAITING_SELECTION");
  const events = await store.events(queued);
  expect(events.some((event) => event.type === "discovery.started")).toBe(false);
  expect(events.find((event) => event.type === "discovery.failed")?.payload).toMatchObject({
    status: "BLOCKED", reason: "tenant_disabled", attempted: false, fallbackUsed: true,
  });
  const set = SuggestionSetResponseSchema.parse((await client.suggestions(queued)).json);
  expect(set.suggestions.length).toBeGreaterThan(0);
  expect(set.suggestions.some((item) => item.discovery)).toBe(false);
  expect((await client.cancel(queued)).status).toBe(202);
});

it.runIf(Boolean(stack.discoveryFixtureUrl))("rolls back in flight: a disable during a running job cancels it and offers standard ideas", async () => {
  const url = stack.discoveryFixtureUrl!;
  expect((await client.call("PUT", "/v1/settings/discovery", { enabled: true })).status).toBe(200);
  const runId = await client.create({ targetUrl: url, environment: "staging", options: { autonomousDiscovery: true } });
  // Disable as soon as the broker job has started (the worker re-checks the flag every 2 s while it runs).
  for (let i = 0; i < 300 && !(await store.events(runId)).some((event) => event.type === "discovery.started"); i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect((await client.call("PUT", "/v1/settings/discovery", { enabled: false })).status).toBe(200);
  await client.waitFor(runId, (run) => run.lifecycle === "AWAITING_SELECTION");
  const events = await store.events(runId);
  expect(events.some((event) => event.type === "discovery.started")).toBe(true);
  expect(events.find((event) => event.type === "discovery.failed")?.payload).toMatchObject({
    status: "CANCELLED", reason: "tenant_disabled", attempted: true, fallbackUsed: true,
  });
  const set = SuggestionSetResponseSchema.parse((await client.suggestions(runId)).json);
  expect(set.suggestions.some((item) => item.discovery)).toBe(false);
  expect((await client.cancel(runId)).status).toBe(202);
  // The broker cancelled and removed the job's container.
  const broker = process.env.BROWSER_USE_DISCOVERY_SERVICE_URL;
  if (broker) {
    for (let i = 0; i < 100 && (await (await fetch(`${broker}/internal/health`)).json()).activeJobs !== 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(await (await fetch(`${broker}/internal/health`)).json()).toMatchObject({ activeJobs: 0, cleanupFailures: 0 });
  }
  expect(execFileSync("docker", ["ps", "-aq", "--filter", "label=vtp.browser-use-discovery=1"], { encoding: "utf8" }).trim()).toBe("");
});

it.runIf(Boolean(stack.discoveryFixtureUrl))("keeps the broker's signing token in the worker only", () => {
  expect(stack.discoveryEnvNames.api).not.toContain("BROWSER_USE_DISCOVERY_SERVICE_TOKEN");
  expect(stack.discoveryEnvNames.api).toContain("BROWSER_USE_DISCOVERY_FIXTURE_URL");
  if (process.env.BROWSER_USE_DISCOVERY_SERVICE_URL) expect(stack.discoveryEnvNames.worker).toContain("BROWSER_USE_DISCOVERY_SERVICE_TOKEN");
});

/**
 * Local deployment rehearsal (not a deployed staging environment): a real Prometheus scrapes this stack's worker
 * with the shipped alert rules. Needs Docker and the prom/prometheus:v3.5.0 image.
 */
it.runIf(Boolean(stack.discoveryFixtureUrl) && process.env.BROWSER_USE_DISCOVERY_REHEARSAL === "1")(
  "rehearsal: Prometheus scrapes the worker's discovery metrics and evaluates every shipped alert rule",
  async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "vtp-prom-rehearsal-"));
    const port = new URL(stack.workerMetricsUrl).port;
    writeFileSync(path.join(dir, "prometheus.yml"), [
      "global: { scrape_interval: 2s, evaluation_interval: 2s }",
      "rule_files: [/rules/browser-use-discovery.rules.yml]",
      `scrape_configs: [{ job_name: worker, static_configs: [{ targets: ['host.docker.internal:${port}'] }] }]`,
    ].join("\n") + "\n");
    const rules = path.resolve(import.meta.dirname, "../../infra/monitoring");
    const name = `vtp-prom-rehearsal-${process.pid}`;
    execFileSync("docker", ["run", "-d", "--rm", "--name", name, "-p", "127.0.0.1::9090",
      "-v", `${dir}/prometheus.yml:/etc/prometheus/prometheus.yml:ro`, "-v", `${rules}:/rules:ro`, "prom/prometheus:v3.5.0"]);
    try {
      const prom = `http://${execFileSync("docker", ["port", name, "9090/tcp"], { encoding: "utf8" }).trim().split("\n")[0]}`;
      const get = async (pathname: string) => {
        for (let i = 0; i < 60; i++) {
          try {
            const res = await fetch(prom + pathname);
            if (res.ok) return (await res.json()).data;
          } catch { /* starting */ }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        throw new Error(`Prometheus did not answer ${pathname}`);
      };
      let targets: { health: string }[] = [];
      for (let i = 0; i < 40 && targets[0]?.health !== "up"; i++) {
        targets = (await get("/api/v1/targets")).activeTargets;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      expect(targets[0]?.health).toBe("up");
      const groups: { rules: { name: string; health: string }[] }[] = (await get("/api/v1/rules")).groups;
      const loaded = groups.flatMap((group) => group.rules);
      expect(loaded.length).toBeGreaterThanOrEqual(11);
      await new Promise((resolve) => setTimeout(resolve, 5_000)); // a few evaluations
      const evaluated: { name: string; health: string }[] = (await get("/api/v1/rules")).groups.flatMap((group: { rules: unknown[] }) => group.rules);
      expect(evaluated.filter((rule) => rule.health !== "ok")).toEqual([]);
      const query = async (expr: string) => (await get(`/api/v1/query?query=${encodeURIComponent(expr)}`)).result as { metric: Record<string, string>; value: [number, string] }[];
      // The runs above produced these series in the scraped worker.
      expect((await query('discovery_jobs_total{status="COMPLETED"}')).length).toBeGreaterThan(0);
      expect((await query('discovery_jobs_total{reason="tenant_disabled"}')).length).toBeGreaterThan(0);
      expect(Number((await query("sum(discovery_selected_runs_total)"))[0]?.value[1])).toBeGreaterThanOrEqual(1);
      expect(Number((await query("sum(discovery_worker_memory_bytes_count)"))[0]?.value[1])).toBeGreaterThanOrEqual(1);
      expect((await query("discovery_active_jobs"))[0]?.value[1]).toBe("0");
      // Healthy pilot: no Browser Use alert fires.
      expect(await query('ALERTS{alertname=~"BrowserUse.*",alertstate="firing"}')).toEqual([]);
    } finally {
      execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
      rmSync(dir, { recursive: true, force: true });
    }
  },
  120_000,
);

