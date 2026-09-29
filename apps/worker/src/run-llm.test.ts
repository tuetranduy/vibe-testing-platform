import { ModelProviderError, type LlmChoice, type LlmKeyProvider } from "@platform/contracts";
import { LlmCallRepository, ProviderKeyRepository, RunRepository, schema } from "@platform/db";
import { TEST_TENANT_ID } from "@platform/db/testing";
import { FakeTransport, type LlmClient } from "@platform/llm";
import { encryptProviderKey } from "@platform/security";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { silentLogger } from "./deps";
import { analyzeRunJob } from "./jobs/analyze-run";
import { createRunLlmFactory, type RunLlmEnv } from "./run-llm";
import { SECRETS_KEY, createFakeStages, createHarness, eventsOf, seedRun, type WorkerHarness } from "./test-support";

let h: WorkerHarness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => h?.close());
afterEach(async () => {
  vi.unstubAllGlobals();
  await h.tdb.db.delete(schema.llmProviderKeys);
});

/** LLM_PROVIDER=fake with no keys: runs without a recorded choice use the fake engine. */
const ENV: RunLlmEnv = { LLM_PROVIDER: "fake", LLM_MODEL: "claude-sonnet-5" };
const OPUS_HIGH: LlmChoice = { provider: "anthropic", model: "claude-opus-5-5", reasoning: "high" };
const GEMINI_LITE_LOW: LlmChoice = { provider: "gemini", model: "gemini-3.5-flash-lite", reasoning: "low" };

const factory = (env: RunLlmEnv = ENV, transport?: FakeTransport) =>
  createRunLlmFactory({ db: h.tdb.db, secretsKey: SECRETS_KEY, env, logger: silentLogger, ...(transport ? { transport } : {}) });
const saveKey = (provider: LlmKeyProvider, apiKey: string, secretsKey = SECRETS_KEY) =>
  new ProviderKeyRepository(h.tdb.db).set(TEST_TENANT_ID, provider, encryptProviderKey(apiKey, { tenantId: TEST_TENANT_ID, provider }, secretsKey));
const ping = (llm: LlmClient, runId: string) =>
  llm.generateJson({
    system: "",
    messages: [{ role: "user", content: "ping" }],
    jsonSchema: { type: "object" },
    stage: "PLANNING",
    runId,
    signal: new AbortController().signal,
    redact: (v) => v,
  });

/** Gemini's generateContent, answered locally; records each request's API key header and body. */
function stubGemini() {
  const sent: { key: string | null; body: { generationConfig: Record<string, unknown> } }[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    sent.push({ key: new Headers(init.headers).get("x-goog-api-key"), body: JSON.parse(String(init.body)) });
    const reply = {
      candidates: [{ content: { parts: [{ text: '{"ok":true}' }], role: "model" }, finishReason: "STOP", index: 0 }],
      usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 100, thoughtsTokenCount: 300, totalTokenCount: 1400 },
    };
    return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  });
  return sent;
}

describe("createRunLlmFactory: one model client per run", () => {
  it("builds the client from the run's recorded choice (provider, model, reasoning); its calls land in llm_calls under that model", async () => {
    const transport = new FakeTransport().enqueue({ json: { ok: true }, usage: { inputTokens: 1000, outputTokens: 100 } });
    const run = await seedRun(h, { llm: OPUS_HIGH });

    const { choice, llm } = await factory({ ...ENV, ANTHROPIC_API_KEY: "sk-ant-env" }, transport).forRun(run);
    await ping(llm!, run.id);

    expect(choice).toEqual(OPUS_HIGH);
    expect([llm!.model, llm!.reasoning]).toEqual(["claude-opus-5-5", "high"]);
    expect(transport.requests[0]).toMatchObject({ model: "claude-opus-5-5", reasoning: "high" });
    expect(await new LlmCallRepository(h.tdb.db).listByRun(run.id)).toMatchObject([{ stage: "PLANNING", model: "claude-opus-5-5", status: "SUCCESS" }]);
  });

  it("a run without a recorded choice (created before model choice) uses the environment's, as the API resolves it", async () => {
    const env: RunLlmEnv = { LLM_PROVIDER: "gemini", LLM_MODEL: "gemini-3.5-flash-lite", GEMINI_THINKING_LEVEL: "low", GEMINI_API_KEY: "gm-env" };
    const { choice, llm } = await factory(env, new FakeTransport()).forRun(await seedRun(h));
    expect(choice).toEqual(GEMINI_LITE_LOW);
    expect(llm!.reasoning).toBe("low");
  });

  it("the fake engine's choice has no client", async () => {
    const fake: LlmChoice = { provider: "fake", model: "fake", reasoning: "default" };
    expect(await factory().forRun(await seedRun(h, { llm: fake }))).toEqual({ choice: fake, llm: null });
    expect(await factory().forRun(await seedRun(h))).toEqual({ choice: fake, llm: null });
  });

  it("the key saved in Settings wins over the environment's: it reaches Gemini with the run's thinking level, priced as Gemini", async () => {
    const sent = stubGemini();
    await saveKey("gemini", "gm-saved-in-settings");
    const run = await seedRun(h, { llm: GEMINI_LITE_LOW });

    const { llm } = await factory({ ...ENV, GEMINI_API_KEY: "gm-from-env" }).forRun(run);
    await ping(llm!, run.id);

    expect(sent[0]!.key).toBe("gm-saved-in-settings");
    expect(sent[0]!.body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "LOW" });
    // Thinking tokens are priced as output: 1000 × $0.30 + 400 × $2.50 per MTok.
    expect(await new LlmCallRepository(h.tdb.db).listByRun(run.id)).toMatchObject([
      { provider: "gemini", model: "gemini-3.5-flash-lite", inputTokens: 1000, outputTokens: 400, estimatedCostUsd: 0.0013, status: "SUCCESS" },
    ]);
  });

  it("without a saved key, the environment's (trimmed)", async () => {
    const sent = stubGemini();
    const run = await seedRun(h, { llm: GEMINI_LITE_LOW });
    await ping((await factory({ ...ENV, GEMINI_API_KEY: " gm-from-env\n" }).forRun(run)).llm!, run.id);
    expect(sent[0]!.key).toBe("gm-from-env");
  });

  it("no key in Settings or the environment → ModelProviderError naming the fix", async () => {
    const err = await factory().forRun(await seedRun(h, { llm: OPUS_HIGH })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelProviderError);
    expect((err as Error).message).toBe("No API key for Anthropic: add one in Settings");
    const gemini = await factory().forRun(await seedRun(h, { llm: GEMINI_LITE_LOW })).catch((e: unknown) => e);
    expect((gemini as Error).message).toBe("No API key for Google Gemini: add one in Settings");
  });

  it("a saved key that can't be decrypted (SECRETS_ENCRYPTION_KEY rotated) → ModelProviderError asking for it again, even with an environment key", async () => {
    await saveKey("anthropic", "sk-ant-under-the-old-key", Buffer.alloc(32, 1));
    const err = await factory({ ...ENV, ANTHROPIC_API_KEY: "sk-ant-env" }).forRun(await seedRun(h, { llm: OPUS_HIGH })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelProviderError);
    expect((err as Error).message).toBe("The saved Anthropic key can't be read (was SECRETS_ENCRYPTION_KEY rotated?): enter it again in Settings");
  });

  it("the injected test transport serves every run (the E2E scripted model), after the same key checks", async () => {
    const transport = new FakeTransport().enqueue({ json: { ok: true } });
    await saveKey("gemini", "gm-saved");
    const run = await seedRun(h, { llm: { provider: "gemini", model: "gemini-3.8-flash", reasoning: "default" } });
    const { llm } = await factory(ENV, transport).forRun(run);
    await ping(llm!, run.id);
    expect(transport.requests[0]!.model).toBe("gemini-3.8-flash");
    await expect(factory(ENV, transport).forRun(await seedRun(h, { llm: OPUS_HIGH }))).rejects.toBeInstanceOf(ModelProviderError);
  });

  it("LLM_PROVIDER=openai stops the worker at start-up: not implemented in V1", () => {
    expect(() => factory({ LLM_PROVIDER: "openai", LLM_MODEL: "gpt-x" })).toThrow(/LLM_PROVIDER=openai is not implemented in V1/);
  });
});

describe("a run whose model client can't be built", () => {
  it.each([
    ["no key anywhere", async () => {}, "No API key for Anthropic: add one in Settings"],
    [
      "a saved key that can't be decrypted",
      async () => void (await saveKey("anthropic", "sk-ant-under-the-old-key", Buffer.alloc(32, 1))),
      "The saved Anthropic key can't be read (was SECRETS_ENCRYPTION_KEY rotated?): enter it again in Settings",
    ],
  ])("%s → ERRORED / MODEL_PROVIDER with that message, before any model call", async (_what, arrange, message) => {
    await arrange();
    const transport = new FakeTransport();
    const run = await seedRun(h, { llm: OPUS_HIGH, secrets: { password: "pw-123456" } });

    await analyzeRunJob(h.deps(createFakeStages(), { runLlm: factory(ENV, transport) }), run.id);

    const after = await new RunRepository(h.tdb.db).getById(run.id);
    expect([after.lifecycle, after.errorCategory, after.errorMessage]).toEqual(["ERRORED", "MODEL_PROVIDER", message]);
    expect((await eventsOf(h, run.id)).find((e) => e.type === "run.errored")?.payload).toEqual({ category: "MODEL_PROVIDER", message });
    expect(transport.requests).toEqual([]);
  });
});
