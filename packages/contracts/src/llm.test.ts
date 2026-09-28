import { describe, expect, it } from "vitest";
import {
  LlmChoiceSchema,
  LlmDefaultsInputSchema,
  LlmKeyProviderSchema,
  LlmOverrideSchema,
  LlmProviderSchema,
  LlmSettingsViewSchema,
  ProviderKeyInputSchema,
  ReasoningLevelSchema,
  UpdateLlmSettingsRequestSchema,
  type LlmSettingsView,
  type StoredTestRunRequest,
} from "./index";

describe("LLM choice contracts", () => {
  it("names the providers, the providers that take a key, and the reasoning levels", () => {
    expect(LlmProviderSchema.options).toEqual(["anthropic", "gemini", "fake"]);
    expect(LlmKeyProviderSchema.options).toEqual(["anthropic", "gemini"]);
    expect(ReasoningLevelSchema.options).toEqual(["default", "minimal", "low", "medium", "high"]);
  });

  it("a run's choice is a provider, a model id of 1–100 characters and a level", () => {
    const choice = { provider: "anthropic", model: "claude-sonnet-5", reasoning: "medium" } as const;
    expect(LlmChoiceSchema.parse(choice)).toEqual(choice);
    expect(LlmChoiceSchema.safeParse({ ...choice, provider: "openai" }).success).toBe(false);
    expect(LlmChoiceSchema.safeParse({ ...choice, model: "" }).success).toBe(false);
    expect(LlmChoiceSchema.safeParse({ ...choice, model: "m".repeat(101) }).success).toBe(false);
    expect(LlmChoiceSchema.safeParse({ ...choice, reasoning: "xhigh" }).success).toBe(false);
  });

  it("a stored request may carry the resolved choice, or none (runs created before model choice)", () => {
    const withChoice: Pick<StoredTestRunRequest, "llm"> = { llm: { provider: "gemini", model: "gemini-3.8-flash", reasoning: "low" } };
    const without: Pick<StoredTestRunRequest, "llm"> = {};
    expect(withChoice.llm?.provider).toBe("gemini");
    expect(without.llm).toBeUndefined();
  });

  it("an override names a model, a level, both or neither (the API checks the catalog)", () => {
    expect(LlmOverrideSchema.parse({})).toEqual({});
    expect(LlmOverrideSchema.parse({ reasoning: "high" })).toEqual({ reasoning: "high" });
    expect(LlmOverrideSchema.parse({ model: "not-in-any-catalog" })).toEqual({ model: "not-in-any-catalog" });
    expect(LlmOverrideSchema.safeParse({ model: "" }).success).toBe(false);
    expect(LlmOverrideSchema.safeParse({ reasoning: "max" }).success).toBe(false);
  });

  it("the defaults input and the settings PUT body", () => {
    expect(UpdateLlmSettingsRequestSchema.parse({ defaults: { model: "claude-opus-5-5", reasoning: "low" } })).toEqual({
      defaults: { model: "claude-opus-5-5", reasoning: "low" },
    });
    expect(LlmDefaultsInputSchema.safeParse({ model: "claude-opus-5-5" }).success).toBe(false);
    expect(UpdateLlmSettingsRequestSchema.safeParse({ model: "claude-opus-5-5", reasoning: "low" }).success).toBe(false);
  });
});

describe("ProviderKeyInputSchema", () => {
  it("trims a key, and takes null to remove the saved one", () => {
    expect(ProviderKeyInputSchema.parse({ apiKey: "  sk-ant-api03-abc_DEF-123  " })).toEqual({ apiKey: "sk-ant-api03-abc_DEF-123" });
    expect(ProviderKeyInputSchema.parse({ apiKey: null })).toEqual({ apiKey: null });
    expect(ProviderKeyInputSchema.safeParse({}).success).toBe(false);
  });

  it.each([
    ["an inner space", "sk-ant secret-part"],
    ["a non-ASCII character", "gm-schlüssel-geheim"],
    ["a tab", "sk-ant\tsecret-part"],
    ["a line break", "sk-ant\nsecret-part"],
    ["only whitespace", "   "],
    ["more than 500 characters", `sk-${"x".repeat(498)}`],
  ])("rejects a key with %s, and no issue repeats the value", (_what, apiKey) => {
    const r = ProviderKeyInputSchema.safeParse({ apiKey });
    expect(r.success).toBe(false);
    const text = `${JSON.stringify(r.error!.issues)} ${r.error!.message}`;
    expect(text).not.toContain("secret-part");
    expect(text).not.toContain("geheim");
    expect(text).not.toContain("xxxxxxxxxx");
    for (const issue of r.error!.issues) expect(issue.path).toEqual(["apiKey"]);
  });
});

describe("LlmSettingsViewSchema", () => {
  const view: LlmSettingsView = {
    defaults: { provider: "anthropic", model: "claude-sonnet-5", label: "Claude Sonnet 5", reasoning: "default", source: "environment", available: true },
    providers: [
      { provider: "anthropic", label: "Anthropic", key: { source: "environment", updatedAt: null } },
      { provider: "gemini", label: "Google Gemini", key: { source: "settings", updatedAt: "2026-09-28T10:00:00.000Z" } },
    ],
    models: [
      {
        provider: "anthropic",
        id: "claude-sonnet-5",
        label: "Claude Sonnet 5",
        reasoningLevels: ["default", "low", "medium", "high"],
        defaultLevel: "high",
        price: { inputUsdPerMTok: 2, outputUsdPerMTok: 10 },
        available: true,
      },
      { provider: "fake", id: "fake", label: "Fake engine (development)", reasoningLevels: ["default"], defaultLevel: null, price: null, available: true },
    ],
  };

  it("parses a view", () => {
    expect(LlmSettingsViewSchema.parse(view)).toEqual(view);
  });

  it("has no field that could hold a key", () => {
    expect(Object.keys(LlmSettingsViewSchema.shape.providers.element.shape.key.shape)).toEqual(["source", "updatedAt"]);
    const strict = LlmSettingsViewSchema.parse({ ...view, providers: [{ ...view.providers[0]!, key: { ...view.providers[0]!.key, apiKey: "sk-ant-leak" } }] });
    expect(JSON.stringify(strict)).not.toContain("sk-ant-leak");
  });
});
