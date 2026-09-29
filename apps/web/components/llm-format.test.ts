import { describe, expect, it } from "vitest";
import { llmSettingsFixture } from "../test/fixtures";
import { llmChoiceText, modelDefaultLabel, modelGroups, priceText } from "./llm-format";

describe("llm-format", () => {
  it("names a run's model and reasoning", () => {
    expect(llmChoiceText({ provider: "anthropic", model: "claude-sonnet-5", label: "Claude Sonnet 5", reasoning: "medium" })).toBe("Claude Sonnet 5 · medium reasoning");
    expect(llmChoiceText({ provider: "anthropic", model: "claude-sonnet-5", label: "Claude Sonnet 5", reasoning: "default" })).toBe("Claude Sonnet 5 · model default");
  });

  it("says what a model's default level is", () => {
    expect(modelDefaultLabel({ defaultLevel: "high" })).toBe("Model default (high)");
    expect(modelDefaultLabel({ defaultLevel: null })).toBe("Model default (no reasoning)");
    expect(modelDefaultLabel(undefined)).toBe("Model default");
  });

  it("prices per million tokens", () => {
    expect(priceText({ inputUsdPerMTok: 2, outputUsdPerMTok: 10 })).toBe("$2.00 input · $10.00 output per million tokens");
    expect(priceText(null)).toBe("No price on record for this model");
  });

  it("groups the models by provider, Development last and only when offered", () => {
    const { models } = llmSettingsFixture();
    expect(modelGroups(models).map((g) => [g.label, g.models.length])).toEqual([
      ["Anthropic", 3],
      ["Google Gemini", 2],
      ["Development", 1],
    ]);
    expect(modelGroups(models.filter((m) => m.provider !== "fake")).map((g) => g.label)).toEqual(["Anthropic", "Google Gemini"]);
  });
});
