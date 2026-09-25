import type { Env } from "@platform/config";
import { LlmCallRepository, type Database } from "@platform/db";
import { LlmClient, createTransport, type LlmTransport } from "@platform/llm";
import { createFakeStages, createRealStages, type EngineStages, type FakeEngineOptions } from "@platform/testing-engine";
import type { WorkerLogger } from "./deps";

export type EngineConfig = Pick<Env, "LLM_PROVIDER" | "LLM_MODEL"> & Partial<Pick<Env, "ANTHROPIC_API_KEY" | "OPENAI_API_KEY">>;

export interface EngineSelection {
  kind: "fake" | "real";
  stages: EngineStages;
  llm: LlmClient | null;
}

/**
 * Ruling R7: LLM_PROVIDER=fake keeps the full fake engine (demo/compose work without a key);
 * otherwise the real stages (currently: analyze) over the fake engine for the stages not built yet.
 * Throws at startup for providers not implemented in V1.
 */
export function createEngine(
  config: EngineConfig,
  deps: { db: Database; logger: WorkerLogger; fake?: FakeEngineOptions; transport?: LlmTransport },
): EngineSelection {
  const fake = createFakeStages(deps.fake);
  if (config.LLM_PROVIDER === "fake") return { kind: "fake", stages: fake, llm: null };

  const transport =
    deps.transport ?? createTransport({ provider: config.LLM_PROVIDER, anthropicApiKey: config.ANTHROPIC_API_KEY });
  const calls = new LlmCallRepository(deps.db);
  const llm = new LlmClient({
    transport,
    model: config.LLM_MODEL,
    recordCall: async (call) => {
      await calls.create(call);
    },
    onRecordError: (err, call) => deps.logger.warn({ err, runId: call.runId }, "failed to record LLM call"),
  });
  return { kind: "real", stages: createRealStages({ llm }, fake), llm };
}
