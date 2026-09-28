import os from "node:os";
import path from "node:path";
import { resolveEnvLlmChoice, type Env } from "@platform/config";
import { LlmCallRepository, type Database } from "@platform/db";
import { LlmClient, createTransport, type LlmTransport } from "@platform/llm";
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
import { recordLlmCall, type WorkerMetrics } from "./metrics";
import { createReportDeps } from "./report";
import { createRunTestDeps } from "./rerun";

export type EngineConfig = Pick<Env, "LLM_PROVIDER" | "LLM_MODEL"> &
  Partial<
    Pick<
      Env,
      | "ANTHROPIC_API_KEY"
      | "GEMINI_API_KEY"
      | "GEMINI_THINKING_LEVEL"
      | "OPENAI_API_KEY"
      | "TARGET_PRIVATE_ALLOWLIST"
      | "ARTIFACT_RETENTION_DAYS"
      | "SECRET_ARTIFACT_RETENTION_DAYS"
      | "RUNNER_WORKSPACE_DIR"
      | "RUNNER_NODE_MODULES_DIR"
    >
  >;

/** Where reruns get their workspaces (Ruling R32): RUNNER_WORKSPACE_DIR / RUNNER_NODE_MODULES_DIR, with defaults. */
export function rerunWorkspaceConfig(config: Pick<EngineConfig, "RUNNER_WORKSPACE_DIR" | "RUNNER_NODE_MODULES_DIR">): WorkspaceConfig {
  return {
    baseDir: config.RUNNER_WORKSPACE_DIR ?? path.join(os.tmpdir(), "platform-runs"),
    nodeModulesDir: config.RUNNER_NODE_MODULES_DIR,
  };
}

export interface EngineSelection {
  kind: "fake" | "real";
  stages: EngineStages;
  llm: LlmClient | null;
}

export interface EngineDeps {
  db: Database;
  logger: WorkerLogger;
  fake?: FakeEngineOptions;
  transport?: LlmTransport;
  /** Artifact storage for exploration screenshots and rerun evidence. Required by the real engine. */
  storage?: ArtifactStorage;
  /** Test seams for the real explore stage (sandbox, explorer, recorder). */
  exploration?: Partial<ExploreStageDeps>;
  /** Test seams for the real rerun stage (proxy, runner child process, workspace, evidence store). */
  rerun?: Partial<RunTestStageDeps>;
  /** Prometheus metrics (LLM calls, sandbox sessions, egress blocks, artifact uploads). */
  metrics?: WorkerMetrics;
}

/**
 * Ruling R7: LLM_PROVIDER=fake keeps the full fake engine (demo/compose work without a key);
 * otherwise every stage is real (analyze, plan, explore, verify, generate test, rerun, report — the
 * report with LLM diagnostics, Ruling R37).
 * Throws at startup for providers not implemented in V1.
 */
export function createEngine(config: EngineConfig, deps: EngineDeps): EngineSelection {
  if (config.LLM_PROVIDER === "fake") {
    // The fake test is persisted like the real one, so the report (read by the API) includes it.
    const fake: FakeEngineOptions = { generatedTestStore: createGenerateTestDeps(deps.db).store, ...deps.fake };
    return { kind: "fake", stages: createFakeStages(fake), llm: null };
  }

  // The environment's model choice; throws for LLM_PROVIDER=openai (not built in V1).
  const choice = resolveEnvLlmChoice(config);
  const transport =
    deps.transport ??
    createTransport({ provider: choice.provider, apiKey: choice.provider === "gemini" ? config.GEMINI_API_KEY : config.ANTHROPIC_API_KEY });
  if (!deps.storage) throw new Error("The real test engine needs artifact storage (exploration screenshots)");
  const calls = new LlmCallRepository(deps.db);
  const llm = new LlmClient({
    transport,
    model: choice.model,
    reasoning: choice.reasoning,
    logger: deps.logger,
    recordCall: async (call) => {
      if (deps.metrics) recordLlmCall(deps.metrics, call);
      await calls.create(call);
    },
    onRecordError: (err, call) => deps.logger.warn({ err, runId: call.runId }, "failed to record LLM call"),
  });
  const retention = {
    artifactRetentionDays: config.ARTIFACT_RETENTION_DAYS ?? 30,
    secretArtifactRetentionDays: config.SECRET_ARTIFACT_RETENTION_DAYS ?? 7,
  };
  const privateAllowlist = config.TARGET_PRIVATE_ALLOWLIST ?? [];
  const exploration = createExplorationDeps({
    db: deps.db,
    storage: deps.storage,
    logger: deps.logger,
    llm,
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
  const report = createReportDeps({ db: deps.db, logger: deps.logger, llm });
  return { kind: "real", stages: createRealStages({ llm, exploration, generateTest: createGenerateTestDeps(deps.db, deps.logger), runTest, report }), llm };
}
