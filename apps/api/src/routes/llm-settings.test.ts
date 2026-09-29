import { LlmSettingsViewSchema, type LlmSettingsView } from "@platform/contracts";
import { ProviderKeyRepository, schema } from "@platform/db";
import { TEST_TENANT_ID } from "@platform/db/testing";
import { decryptProviderKey } from "@platform/security";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ApiLlmConfig } from "../deps";
import { SECRETS_KEY, auth, createTestApi, type TestApi } from "../test-support";

let t: TestApi;
beforeAll(async () => {
  t = await createTestApi();
});
afterAll(async () => t?.close());

/** The environment: LLM_PROVIDER=anthropic, default model, and which keys it sets. */
const env = (keys: Partial<ApiLlmConfig["envKeys"]> = {}, patch: Partial<ApiLlmConfig> = {}): ApiLlmConfig => ({
  envChoice: { provider: "anthropic", model: "claude-sonnet-5", reasoning: "default" },
  envKeys: { anthropic: false, gemini: false, ...keys },
  fakeAllowed: true,
  ...patch,
});

beforeEach(async () => {
  t.deps.config.llm = env();
  t.audit.length = 0;
  await t.tdb.db.delete(schema.llmProviderKeys);
  await t.tdb.db.delete(schema.llmSettings);
});

const get = () => t.app.inject({ method: "GET", url: "/v1/settings/llm", headers: auth });
const putDefaults = (defaults: unknown) => t.app.inject({ method: "PUT", url: "/v1/settings/llm", headers: auth, payload: { defaults } });
const putKey = (provider: string, apiKey: string | null) =>
  t.app.inject({ method: "PUT", url: `/v1/settings/llm/keys/${provider}`, headers: auth, payload: { apiKey } });
const viewOf = (res: { json(): unknown }): LlmSettingsView => LlmSettingsViewSchema.parse(res.json());
const storedKey = async (provider: "anthropic" | "gemini") => {
  const enc = await new ProviderKeyRepository(t.tdb.db).getEncrypted(TEST_TENANT_ID, provider);
  return enc && decryptProviderKey(enc, { tenantId: TEST_TENANT_ID, provider }, SECRETS_KEY);
};

describe("GET /v1/settings/llm", () => {
  it("with nothing saved: the environment's defaults and keys, and every offered model with its levels, price and availability", async () => {
    t.deps.config.llm = env({ anthropic: true });
    const view = viewOf(await get());
    expect(view.defaults).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-5",
      label: "Claude Sonnet 5",
      reasoning: "default",
      source: "environment",
      available: true,
    });
    expect(view.providers).toEqual([
      { provider: "anthropic", label: "Anthropic", key: { source: "environment", updatedAt: null } },
      { provider: "gemini", label: "Google Gemini", key: { source: null, updatedAt: null } },
    ]);
    expect(view.models.map((m) => m.id)).toEqual([
      "claude-fable-5-1",
      "claude-opus-5-5",
      "claude-sonnet-5",
      "claude-haiku-4-5",
      "gemini-3.8-flash",
      "gemini-3.5-flash",
      "gemini-3.5-flash-lite",
      "gemini-3.1-pro-preview",
      "fake",
    ]);
    expect(view.models.find((m) => m.id === "claude-opus-5-5")).toEqual({
      provider: "anthropic",
      id: "claude-opus-5-5",
      label: "Claude Opus 5.5",
      reasoningLevels: ["default", "low", "medium", "high"],
      defaultLevel: "medium",
      price: { inputUsdPerMTok: 4, outputUsdPerMTok: 20 },
      available: true,
    });
    expect(view.models.find((m) => m.id === "gemini-3.8-flash")!.available).toBe(false);
    expect(view.models.find((m) => m.id === "fake")).toMatchObject({ price: null, available: true });
  });

  it("in production the fake engine is not offered", async () => {
    t.deps.config.llm = env({ anthropic: true }, { fakeAllowed: false });
    expect(viewOf(await get()).models.map((m) => m.id)).not.toContain("fake");
  });

  it("an environment model outside the catalog is shown by its id, and stays usable", async () => {
    t.deps.config.llm = env({ anthropic: true }, { envChoice: { provider: "anthropic", model: "claude-opus-5", reasoning: "default" } });
    const view = viewOf(await get());
    expect(view.defaults).toMatchObject({ model: "claude-opus-5", label: "claude-opus-5", source: "environment", available: true });
    expect(view.models.map((m) => m.id)).not.toContain("claude-opus-5");
  });

  it("the answer never contains a key, saved or from the environment (raw body)", async () => {
    t.deps.config.llm = env({ anthropic: true });
    const saved = "AIza-Saved-Gemini-Key-0042";
    const put = await putKey("gemini", saved);
    expect(put.statusCode).toBe(200);
    const res = await get();
    for (const body of [put.body, res.body]) {
      expect(body).not.toContain(saved);
      expect(body).not.toMatch(/apiKey|ciphertext/i);
    }
    expect(viewOf(res).providers).toEqual([
      { provider: "anthropic", label: "Anthropic", key: { source: "environment", updatedAt: null } },
      { provider: "gemini", label: "Google Gemini", key: { source: "settings", updatedAt: expect.any(String) } },
    ]);
  });
});

describe("PUT /v1/settings/llm/keys/:provider", () => {
  it("saves a key encrypted and trimmed, replaces it, removes it; audit lines name the provider, never the key", async () => {
    const first = "AIza-First-Key-111";
    const second = "AIza-Second-Key-222";
    expect((await putKey("gemini", `  ${first}\n`)).statusCode).toBe(200); // pasted with a trailing newline
    expect(await storedKey("gemini")).toBe(first);
    const replaced = viewOf(await putKey("gemini", second));
    expect(replaced.providers[1]!.key.source).toBe("settings");
    expect(await storedKey("gemini")).toBe(second);
    const removed = viewOf(await putKey("gemini", null));
    expect(removed.providers[1]!.key).toEqual({ source: null, updatedAt: null });
    expect(await storedKey("gemini")).toBeNull();

    expect(t.audit.map((a) => [a.action, a.provider])).toEqual([
      ["settings.llm.key_saved", "gemini"],
      ["settings.llm.key_saved", "gemini"],
      ["settings.llm.key_removed", "gemini"],
    ]);
    expect(JSON.stringify(t.audit)).not.toMatch(/AIza-/);
  });

  it("removing the saved key falls back to the environment's: the defaults stay usable", async () => {
    t.deps.config.llm = env({ anthropic: true });
    await putKey("anthropic", "sk-ant-api03-Saved-Key");
    const view = viewOf(await putKey("anthropic", null));
    expect(view.providers[0]!.key).toEqual({ source: "environment", updatedAt: null });
    expect(view.defaults.available).toBe(true);
  });

  it("removing a key that was never saved changes nothing and writes no audit line", async () => {
    expect((await putKey("anthropic", null)).statusCode).toBe(200);
    expect(t.audit).toEqual([]);
  });

  it("a malformed key → 400 VALIDATION_FAILED on apiKey, without the value", async () => {
    const res = await putKey("anthropic", "sk-ant with-a-space-Secret");
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "VALIDATION_FAILED", issues: [{ path: ["apiKey"] }] });
    expect(res.body).not.toContain("with-a-space-Secret");
    expect(await storedKey("anthropic")).toBeNull();
  });

  it.each(["openai", "fake", "ANTHROPIC"])("an unknown provider (%s) → 404", async (provider) => {
    expect((await putKey(provider, "sk-test-key")).statusCode).toBe(404);
  });
});

describe("PUT /v1/settings/llm (defaults for new tests)", () => {
  it("saves an offered model whose provider has a key, at one of its levels; the audit line names provider and model", async () => {
    t.deps.config.llm = env({ gemini: true });
    const res = await putDefaults({ model: "gemini-3.5-flash", reasoning: "minimal" });
    expect(res.statusCode).toBe(200);
    expect(viewOf(res).defaults).toEqual({
      provider: "gemini",
      model: "gemini-3.5-flash",
      label: "Gemini 3.5 Flash",
      reasoning: "minimal",
      source: "settings",
      available: true,
    });
    expect(t.audit).toEqual([
      expect.objectContaining({ action: "settings.llm.defaults_saved", provider: "gemini", model: "gemini-3.5-flash", reasoning: "minimal" }),
    ]);
  });

  it.each([
    ["an unknown model", { model: "gpt-x", reasoning: "default" }, ["defaults", "model"]],
    ["a provider without a key", { model: "claude-sonnet-5", reasoning: "default" }, ["defaults", "model"]],
    ["a level the model does not take", { model: "gemini-3.8-flash", reasoning: "minimal" }, ["defaults", "reasoning"]],
  ])("refuses %s: 422 MODEL_NOT_AVAILABLE with the issue path", async (_what, defaults, path) => {
    t.deps.config.llm = env({ gemini: true });
    const res = await putDefaults(defaults);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: "MODEL_NOT_AVAILABLE", issues: [{ path }] });
    expect(viewOf(await get()).defaults.source).toBe("environment");
  });

  it("a key named in the message when the provider has none", async () => {
    expect((await putDefaults({ model: "claude-opus-5-5", reasoning: "low" })).json()).toMatchObject({ message: "Add an Anthropic API key in Settings" });
  });

  it("the fake engine cannot be the default in production", async () => {
    t.deps.config.llm = env({ anthropic: true }, { fakeAllowed: false });
    expect((await putDefaults({ model: "fake", reasoning: "default" })).statusCode).toBe(422);
  });

  it("a malformed body → 400 VALIDATION_FAILED", async () => {
    expect((await putDefaults({ model: "claude-sonnet-5" })).json()).toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("removing the key the saved defaults rely on is allowed: the defaults then show unavailable", async () => {
    await putKey("gemini", "AIza-Only-Key-333");
    expect((await putDefaults({ model: "gemini-3.8-flash", reasoning: "high" })).statusCode).toBe(200);
    const view = viewOf(await putKey("gemini", null));
    expect(view.defaults).toMatchObject({ model: "gemini-3.8-flash", source: "settings", available: false });
  });
});
