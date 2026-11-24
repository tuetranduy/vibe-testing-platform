import type { Redis } from "ioredis";
import { createAssistancePort, assistanceTimeoutMs } from "./assistance";
import os from "node:os";
import path from "node:path";
import { discoveryAdmission, type DiscoveryEnv, type Env } from "@platform/config";
import type { LlmChoice } from "@platform/contracts";
import type { Database } from "@platform/db";
import type { ArtifactStorage } from "@platform/storage";
import { admitDiscoveryRun, discoveryEnabled, refundDiscoveryAttempt, reserveDiscoveryAttempt } from "@platform/event-bus";
import {
  createFakeStages,
  createRealStages,
  prepareVerifiedSite,
  type AnalyzeStageDeps,
  type EngineStages,
  type ExploreStageDeps,
  type FakeEngineOptions,
  type RunTestStageDeps,
  type AutonomousDiscoveryPort,
  type AutonomousSurveyDeps,
  type WorkspaceConfig,
} from "@platform/testing-engine";
import type { WorkerLogger } from "./deps";
import { createBrowserUseDiscoveryClient, createDiscoveryServiceClient } from "./discovery-client";
import { createExplorationDeps, createExplorationStore } from "./exploration";
import { createGenerateTestDeps } from "./generated-test";
import type { WorkerMetrics } from "./metrics";
import { createReportDeps } from "./report";
import { createRunTestDeps } from "./rerun";
import { createSurveyDeps } from "./survey";

/** What the engines read from the environment. The model is not here: it comes with each run (run-llm.ts). */
export type EngineConfig = Partial<
  Pick<
    Env,
    | "TARGET_PRIVATE_ALLOWLIST"
    | "ARTIFACT_RETENTION_DAYS"
    | "SECRET_ARTIFACT_RETENTION_DAYS"
    | "RUNNER_WORKSPACE_DIR"
    | "RUNNER_NODE_MODULES_DIR"
    | "RUNNER_URL"
    | "RUNNER_TOKEN"
    | "BROWSER_USE_DISCOVERY_VERIFIED_SITES"
  > & DiscoveryEnv
>;

/**
 * The survey's Browser Use wiring. Always present, so a run the API admitted still records a typed outcome and
 * metrics here when this worker has no transport (BLOCKED / not_configured) or another fixture (fixture_mismatch).
 */
export function createDiscoveryDeps(config: EngineConfig, deps: Pick<EngineDeps, "discoveryRollout" | "logger" | "metrics">): AutonomousSurveyDeps {
  const admission = discoveryAdmission(config);
  const metrics = deps.metrics;
  const port = !admission
    ? undefined
    : config.BROWSER_USE_DISCOVERY_LAUNCHER
      ? createBrowserUseDiscoveryClient(config.BROWSER_USE_DISCOVERY_LAUNCHER)
      : config.BROWSER_USE_DISCOVERY_SERVICE_URL && config.BROWSER_USE_DISCOVERY_SERVICE_TOKEN
        ? createDiscoveryServiceClient(config.BROWSER_USE_DISCOVERY_SERVICE_URL, config.BROWSER_USE_DISCOVERY_SERVICE_TOKEN, {
            onCleanupError: () => metrics?.discoveryCleanupErrors.inc(),
          })
        : undefined;
  const hourlyLimit = config.BROWSER_USE_DISCOVERY_TENANT_HOURLY_LIMIT ?? 20;
  // In-flight calls per worker process; Prometheus sums workers. The broker's own count is its health endpoint.
  const counted: AutonomousDiscoveryPort | undefined = port && {
    async discover(input, context) {
      metrics?.discoveryActiveJobs.inc();
      try {
        return await port.discover(input, context);
      } finally {
        metrics?.discoveryActiveJobs.dec();
      }
    },
  };
  return {
    ...(admission && counted ? { fixtureUrl: admission.fixtureUrl, port: counted } : {}),
    ...(config.BROWSER_USE_DISCOVERY_VERIFIED_SITES === "on" ? { prepareVerifiedSite } : {}),
    allowsTenant: async (tenantId) => Boolean(admission?.tenantIds.includes(tenantId)) && await discoveryEnabled(deps.discoveryRollout, tenantId),
    reserve: (tenantId) => reserveDiscoveryAttempt(deps.discoveryRollout, tenantId, hourlyLimit),
    refund: (tenantId) => refundDiscoveryAttempt(deps.discoveryRollout, tenantId),
    ...(deps.discoveryRollout && {
      admit: async ({ tenantId, runId, maxWaitMs, leaseMs, signal }) => {
        const admission = await admitDiscoveryRun(deps.discoveryRollout!, tenantId, runId, {
          capacity: config.BROWSER_USE_DISCOVERY_CAPACITY ?? 1, maxWaitMs, leaseMs, signal,
        });
        metrics?.discoveryAdmissionWait.observe({ outcome: admission.granted ? "granted" : "timed_out" }, admission.waitedMs / 1000);
        return admission;
      },
    }),
    logger: deps.logger,
    observe: (summary, elapsedSeconds) => {
      if (!metrics) return;
      metrics.discoveryJobs.inc({ status: summary.status, reason: summary.reason ?? "unknown" });
      // Only attempted jobs: configuration, rollout, quota and capacity refusals take no time to report.
      if (elapsedSeconds !== null) metrics.discoveryDuration.observe(elapsedSeconds);
      if (summary.fallbackUsed) metrics.discoveryFallback.inc();
      metrics.discoveryCandidates.inc({ kind: "returned" }, summary.candidateCount);
      metrics.discoveryCandidates.inc({ kind: "accepted" }, summary.acceptedCount);
      if (summary.statistics) {
        metrics.discoverySteps.observe(summary.statistics.agentSteps);
        if (summary.statistics.modelCostUsd !== null) metrics.discoveryCost.inc(summary.statistics.modelCostUsd);
        if (summary.statistics.protocolViolations) metrics.discoveryProtocolViolations.inc(summary.statistics.protocolViolations);
        if (summary.statistics.peakMemoryBytes != null) metrics.discoveryWorkerMemory.observe(summary.statistics.peakMemoryBytes);
        for (const [reason, count] of Object.entries(summary.statistics.blockedByReason ?? {})) {
          if (count) metrics.discoveryBlockedDestinations.inc({ reason }, count);
        }
      }
    },
  };
}

/** Where reruns get their workspaces (Ruling R32): RUNNER_WORKSPACE_DIR / RUNNER_NODE_MODULES_DIR, with defaults. */
export function rerunWorkspaceConfig(config: Pick<EngineConfig, "RUNNER_WORKSPACE_DIR" | "RUNNER_NODE_MODULES_DIR">): WorkspaceConfig {
  return {
    baseDir: config.RUNNER_WORKSPACE_DIR ?? path.join(os.tmpdir(), "platform-runs"),
    nodeModulesDir: config.RUNNER_NODE_MODULES_DIR,
  };
}

/** Both engines, built once at start-up; each run uses the one its model choice names. */
export interface Engines {
  fake: EngineStages;
  real: EngineStages;
  /** Ruling R7: the fake engine for the `fake` choice (no model, no key), the real one for any other. */
  for(choice: LlmChoice): EngineStages;
}

export interface EngineDeps {
  redis?: Redis;
  /** The tenant rollout flag and hourly attempt quota. Absent: discovery admission stays closed on this worker. */
  discoveryRollout?: Pick<Redis, "get" | "eval">;
  db: Database;
  logger: WorkerLogger;
  fake?: FakeEngineOptions;
  /** Artifact storage for exploration screenshots and rerun evidence. */
  storage: ArtifactStorage;
  /** Test seams for the real explore stage (sandbox, explorer, recorder). */
  exploration?: Partial<ExploreStageDeps>;
  /** Test seams for the real rerun stage (proxy, runner child process, workspace, evidence store). */
  rerun?: Partial<RunTestStageDeps>;
  /** Prometheus metrics (sandbox sessions, egress blocks, artifact uploads). */
  metrics?: WorkerMetrics;
  /** Test seam for the real analyze stage (V1.3: its live-site read); default: the survey's sandbox and store. */
  analyze?: AnalyzeStageDeps;
}

/**
 * Ruling R7, per run: the fake engine (demo and compose work without a key) and the real one, where every
 * stage is real (analyze, plan, explore, verify, generate test, rerun, report — with LLM diagnostics, Ruling
 * R37) and makes its model calls through the run's own client (StageContext.llm, built by run-llm.ts).
 */
export function createEngines(config: EngineConfig, deps: EngineDeps): Engines {
  // The fake test is persisted like the real one, so the report (read by the API) includes it.
  const fake = createFakeStages({ generatedTestStore: createGenerateTestDeps(deps.db).store, ...deps.fake });
  const retention = {
    artifactRetentionDays: config.ARTIFACT_RETENTION_DAYS ?? 30,
    secretArtifactRetentionDays: config.SECRET_ARTIFACT_RETENTION_DAYS ?? 7,
  };
  const privateAllowlist = config.TARGET_PRIVATE_ALLOWLIST ?? [];
  const exploration = createExplorationDeps({
    db: deps.db,
    storage: deps.storage,
    logger: deps.logger,
    metrics: deps.metrics,
    config: { privateAllowlist, ...retention },
    ...(deps.exploration ? { overrides: deps.exploration } : {}),
  });
  if (deps.redis) exploration.assistance = (ctx) => createAssistancePort(deps.redis!, ctx.runId, assistanceTimeoutMs());
  const workspace = rerunWorkspaceConfig(config);
  const runTest = createRunTestDeps({
    db: deps.db,
    storage: deps.storage,
    logger: deps.logger,
    metrics: deps.metrics,
    config: {
      privateAllowlist,
      ...retention,
      workspaceDir: workspace.baseDir,
      nodeModulesDir: workspace.nodeModulesDir,
      ...(config.RUNNER_URL && config.RUNNER_TOKEN ? { runner: { url: config.RUNNER_URL, token: config.RUNNER_TOKEN } } : {}),
    },
    ...(deps.rerun ? { overrides: deps.rerun } : {}),
  });
  const report = createReportDeps({ db: deps.db, logger: deps.logger });
  const survey = createSurveyDeps({
    db: deps.db,
    storage: deps.storage,
    logger: deps.logger,
    metrics: deps.metrics,
    config: { privateAllowlist, ...retention },
  });
  const real = createRealStages({
    survey,
    discovery: createDiscoveryDeps(config, deps),
    exploration,
    generateTest: createGenerateTestDeps(deps.db, deps.logger),
    runTest,
    report,
    // V1.3: the requirement is analyzed against the live site, read like the survey reads it (no Stagehand).
    analyze: deps.analyze ?? { site: { openSandbox: survey.openSandbox, store: survey.store, logger: deps.logger } },
    // V1.3: a run whose every criterion is blocked still gets a full-page screenshot of the start page.
    captureEvidence: {
      openSandbox: survey.openSandbox,
      store: (ctx) => createExplorationStore({ db: deps.db, storage: deps.storage, config: retention, metrics: deps.metrics }, ctx),
      logger: deps.logger,
    },
  });
  return { fake, real, for: (choice) => (choice.provider === "fake" ? fake : real) };
}
