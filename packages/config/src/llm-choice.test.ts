import { describe, expect, it } from "vitest";
import { loadEnv, loadLiveLlmEnv } from "./env";
import { resolveEnvLlmChoice } from "./llm-choice";

describe("resolveEnvLlmChoice (the defaults when Settings hold none)", () => {
  it("anthropic: LLM_MODEL, else the provider's default model; reasoning default", () => {
    expect(resolveEnvLlmChoice({ LLM_PROVIDER: "anthropic", LLM_MODEL: "claude-opus-5-5" })).toEqual({ provider: "anthropic", model: "claude-opus-5-5", reasoning: "default" });
    expect(resolveEnvLlmChoice({ LLM_PROVIDER: "anthropic" })).toEqual({ provider: "anthropic", model: "claude-sonnet-5", reasoning: "default" });
    expect(resolveEnvLlmChoice({ LLM_PROVIDER: "anthropic", LLM_MODEL: "" })).toMatchObject({ model: "claude-sonnet-5" });
  });

  it("gemini: GEMINI_THINKING_LEVEL is the reasoning level; unset, the model's default", () => {
    expect(resolveEnvLlmChoice({ LLM_PROVIDER: "gemini", GEMINI_THINKING_LEVEL: "low" })).toEqual({ provider: "gemini", model: "gemini-3.8-flash", reasoning: "low" });
    expect(resolveEnvLlmChoice({ LLM_PROVIDER: "gemini", LLM_MODEL: "gemini-3.5-flash-lite" })).toEqual({ provider: "gemini", model: "gemini-3.5-flash-lite", reasoning: "default" });
  });

  it("GEMINI_THINKING_LEVEL does not apply to anthropic", () => {
    expect(resolveEnvLlmChoice({ LLM_PROVIDER: "anthropic", GEMINI_THINKING_LEVEL: "high" }).reasoning).toBe("default");
  });

  it("fake: the fake engine, whatever LLM_MODEL says", () => {
    expect(resolveEnvLlmChoice({ LLM_PROVIDER: "fake", LLM_MODEL: "claude-sonnet-5" })).toEqual({ provider: "fake", model: "fake", reasoning: "default" });
  });

  it("takes loadEnv's and loadLiveLlmEnv's results as they are", () => {
    const env = loadEnv({
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://x",
      REDIS_URL: "redis://x",
      ARTIFACT_STORAGE_TYPE: "local",
      ARTIFACT_BUCKET: "a",
      LLM_PROVIDER: "gemini",
      GEMINI_THINKING_LEVEL: "medium",
      BROWSER_MODE: "local",
      API_TOKEN: "dev-token-0123456789abcdef",
      DEFAULT_TENANT_ID: "t_default",
      SECRETS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    });
    expect(resolveEnvLlmChoice(env)).toEqual({ provider: "gemini", model: "gemini-3.8-flash", reasoning: "medium" });
    const live = loadLiveLlmEnv({ ANTHROPIC_API_KEY: "sk-test", LLM_MODEL: "claude-haiku-4-5" });
    if ("missingKey" in live) throw new Error("unexpected");
    expect(resolveEnvLlmChoice(live)).toEqual({ provider: "anthropic", model: "claude-haiku-4-5", reasoning: "default" });
  });

  it("LLM_PROVIDER=openai is refused: not implemented in V1 (the API and the worker stop at start-up)", () => {
    expect(() => resolveEnvLlmChoice({ LLM_PROVIDER: "openai", LLM_MODEL: "gpt-x" })).toThrow(/LLM_PROVIDER=openai is not implemented in V1/);
  });
});
