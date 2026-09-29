import os from "node:os";
import path from "node:path";
import type { Env } from "@platform/config";
import type { LlmChoice } from "@platform/contracts";
import type { Database } from "@platform/db";
import type { ArtifactStorage } from "@platform/storage";
import {
  createFakeStages,
  createRealStages,
  type EngineStages,
  type ExploreStageDeps,
  type FakeEngineOptions,
  type RunTestStageDeps,
  type WorkspaceConfig,
} from "@platform/testing-engine";
import type { WorkerLogger } from "./deps";
import { createExplorationDeps } from "./exploration";
import { createGenerateTestDeps } from "./generated-test";
import type { WorkerMetrics } from "./metrics";
import { createReportDeps } from "./report";
import { createRunTestDeps } from "./rerun";
import { createSurveyDeps } from "./survey";

/** What the engines read from the environment. The model is not here: it comes with each run (run-llm.ts). */
export type EngineConfig = Partial<
  Pick<Env, "TARGET_PRIVATE_ALLOWLIST" | "ARTIFACT_RETENTION_DAYS" | "SECRET_ARTIFACT_RETENTION_DAYS" | "RUNNER_WORKSPACE_DIR" | "RUNNER_NODE_MODULES_DIR">
>;

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
  const real = createRealStages({ survey, exploration, generateTest: createGenerateTestDeps(deps.db, deps.logger), runTest, report });
  return { fake, real, for: (choice) => (choice.provider === "fake" ? fake : real) };
}
