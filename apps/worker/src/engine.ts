import type { Env } from "@platform/config";
import { LlmCallRepository, type Database } from "@platform/db";
import { LlmClient, createTransport, type LlmTransport } from "@platform/llm";
import type { ArtifactStorage } from "@platform/storage";
import {
  createFakeStages,
  createRealStages,
  type EngineStages,
  type ExploreStageDeps,
  type FakeEngineOptions,
} from "@platform/testing-engine";
import type { WorkerLogger } from "./deps";
import { createExplorationDeps } from "./exploration";

export type EngineConfig = Pick<Env, "LLM_PROVIDER" | "LLM_MODEL"> &
  Partial<
    Pick<Env, "ANTHROPIC_API_KEY" | "OPENAI_API_KEY" | "TARGET_PRIVATE_ALLOWLIST" | "ARTIFACT_RETENTION_DAYS" | "SECRET_ARTIFACT_RETENTION_DAYS">
  >;

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
  /** Artifact storage for exploration screenshots. Required by the real engine. */
  storage?: ArtifactStorage;
  /** Test seams for the real explore stage (sandbox, explorer, recorder). */
  exploration?: Partial<ExploreStageDeps>;
}

/**
 * Ruling R7: LLM_PROVIDER=fake keeps the full fake engine (demo/compose work without a key);
 * otherwise the real stages (analyze, plan, explore) over the fake engine for the stages not built yet.
 * Throws at startup for providers not implemented in V1.
 */
export function createEngine(config: EngineConfig, deps: EngineDeps): EngineSelection {
  const fake = createFakeStages(deps.fake);
  if (config.LLM_PROVIDER === "fake") return { kind: "fake", stages: fake, llm: null };

  const transport =
    deps.transport ?? createTransport({ provider: config.LLM_PROVIDER, anthropicApiKey: config.ANTHROPIC_API_KEY });
  if (!deps.storage) throw new Error("The real test engine needs artifact storage (exploration screenshots)");
  const calls = new LlmCallRepository(deps.db);
  const llm = new LlmClient({
    transport,
    model: config.LLM_MODEL,
    logger: deps.logger,
    recordCall: async (call) => {
      await calls.create(call);
    },
    onRecordError: (err, call) => deps.logger.warn({ err, runId: call.runId }, "failed to record LLM call"),
  });
  const exploration = createExplorationDeps({
    db: deps.db,
    storage: deps.storage,
    logger: deps.logger,
    llm,
    config: {
      privateAllowlist: config.TARGET_PRIVATE_ALLOWLIST ?? [],
      artifactRetentionDays: config.ARTIFACT_RETENTION_DAYS ?? 30,
      secretArtifactRetentionDays: config.SECRET_ARTIFACT_RETENTION_DAYS ?? 7,
    },
    ...(deps.exploration ? { overrides: deps.exploration } : {}),
  });
  return { kind: "real", stages: createRealStages({ llm, exploration }, fake), llm };
}
