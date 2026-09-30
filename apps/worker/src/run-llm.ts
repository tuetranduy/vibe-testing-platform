import { resolveEnvLlmChoice, type Env } from "@platform/config";
import { ModelProviderError, type LlmChoice, type LlmKeyProvider } from "@platform/contracts";
import { LlmCallRepository, ProviderKeyRepository, type Database, type TestRun } from "@platform/db";
import { LlmClient, PROVIDER_LABELS, createTransport, type LlmTransport } from "@platform/llm";
import { decryptProviderKey } from "@platform/security";
import type { WorkerLogger } from "./deps";
import { recordLlmCall, type WorkerMetrics } from "./metrics";

/** A run's model: its recorded choice (or the environment's), and the client its stages use (StageContext.llm). */
export interface RunLlm {
  choice: LlmChoice;
  /** Null for the fake engine's choice: it makes no model call. */
  llm: LlmClient | null;
}

export interface RunLlmFactory {
  /**
   * The run's model client. Throws ModelProviderError, with a message naming the fix, when the chosen
   * provider has no key or its saved key can't be decrypted.
   */
  forRun(run: TestRun): Promise<RunLlm>;
  /** The run's recorded choice (or the environment's), without building a client. */
  choiceOf(run: TestRun): LlmChoice;
}

/** The LLM_* environment: the choice for runs that recorded none, and the server's provider keys. */
export type RunLlmEnv = Pick<Env, "LLM_PROVIDER" | "LLM_MODEL"> & Partial<Pick<Env, "GEMINI_THINKING_LEVEL" | "ANTHROPIC_API_KEY" | "GEMINI_API_KEY" | "DEEPSEEK_API_KEY">>;

export interface RunLlmFactoryDeps {
  db: Database;
  /** SECRETS_ENCRYPTION_KEY: opens the keys saved in Settings. */
  secretsKey: Buffer;
  env: RunLlmEnv;
  logger: WorkerLogger;
  metrics?: WorkerMetrics;
  /** Test seam (the E2E scripted model): every run's client uses this transport, after the same key checks. */
  transport?: LlmTransport;
}

const ENV_KEYS = { anthropic: "ANTHROPIC_API_KEY", gemini: "GEMINI_API_KEY", deepseek: "DEEPSEEK_API_KEY" } as const;

/**
 * One model client per run, from its recorded choice (`request.llm`); a run created before model choice uses
 * the environment's, resolved as the API resolves it (resolveEnvLlmChoice). The key is the one saved in
 * Settings, decrypted here (the only place a saved key is ever read), else the environment's. Every call is
 * recorded in `llm_calls` and the worker's metrics. Throws for LLM_PROVIDER=openai, which stops the worker
 * at start-up.
 */
export function createRunLlmFactory(deps: RunLlmFactoryDeps): RunLlmFactory {
  const environment = resolveEnvLlmChoice(deps.env);
  const keys = new ProviderKeyRepository(deps.db);
  const calls = new LlmCallRepository(deps.db);

  async function keyFor(tenantId: string, provider: LlmKeyProvider): Promise<string> {
    const label = PROVIDER_LABELS[provider];
    const saved = await keys.getEncrypted(tenantId, provider);
    if (saved) {
      try {
        return decryptProviderKey(saved, { tenantId, provider }, deps.secretsKey);
      } catch (err) {
        deps.logger.warn({ err, tenantId, provider }, "saved provider key could not be decrypted");
        throw new ModelProviderError(`The saved ${label} key can't be read (was SECRETS_ENCRYPTION_KEY rotated?): enter it again in Settings`);
      }
    }
    const fromEnvironment = deps.env[ENV_KEYS[provider]]?.trim();
    if (fromEnvironment) return fromEnvironment;
    throw new ModelProviderError(`No API key for ${label}: add one in Settings`);
  }

  return {
    choiceOf: (run) => run.request.llm ?? environment,
    async forRun(run) {
      const choice = run.request.llm ?? environment;
      if (choice.provider === "fake") return { choice, llm: null };
      const apiKey = await keyFor(run.tenantId, choice.provider);
      const llm = new LlmClient({
        transport: deps.transport ?? createTransport({ provider: choice.provider, apiKey }),
        model: choice.model,
        reasoning: choice.reasoning,
        logger: deps.logger,
        recordCall: async (call) => {
          if (deps.metrics) recordLlmCall(deps.metrics, call);
          await calls.create(call);
        },
        onRecordError: (err, call) => deps.logger.warn({ err, runId: call.runId }, "failed to record LLM call"),
      });
      return { choice, llm };
    },
  };
}
