import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MODEL_CATALOG, PROVIDER_LABELS, catalogModel } from "./catalog";
import { priceFor } from "./pricing";

describe("MODEL_CATALOG", () => {
  it("lists the spec's models with their levels, default level and refusal fallback", () => {
    expect(MODEL_CATALOG.map((m) => [m.provider, m.id, m.reasoningLevels.slice(1).join(","), m.defaultLevel, m.refusalFallback])).toEqual([
      ["anthropic", "claude-fable-5-1", "low,medium,high", "high", true],
      ["anthropic", "claude-opus-5-5", "low,medium,high", "medium", true],
      ["anthropic", "claude-sonnet-5", "low,medium,high", "high", false],
      ["anthropic", "claude-haiku-4-5", "", null, false],
      ["gemini", "gemini-3.8-flash", "low,medium,high", "medium", false],
      ["gemini", "gemini-3.5-flash", "minimal,low,medium,high", "medium", false],
      ["gemini", "gemini-3.5-flash-lite", "minimal,low,medium,high", "minimal", false],
      ["gemini", "gemini-3.1-pro-preview", "low,medium,high", "high", false],
      ["fake", "fake", "", null, false],
    ]);
  });

  it("every model but the fake engine has a price", () => {
    for (const m of MODEL_CATALOG.filter((m) => m.provider !== "fake")) expect(priceFor(m.id), m.id).not.toBeNull();
  });

  it("ids are unique; every model's levels start with default, without repeats; only reasoning models have a default level", () => {
    expect(new Set(MODEL_CATALOG.map((m) => m.id)).size).toBe(MODEL_CATALOG.length);
    for (const m of MODEL_CATALOG) {
      expect(m.reasoningLevels[0], m.id).toBe("default");
      expect(new Set(m.reasoningLevels).size, m.id).toBe(m.reasoningLevels.length);
      expect(m.defaultLevel === null, m.id).toBe(m.reasoningLevels.length === 1);
    }
  });

  it("offers the providers' default models (defaultLlmModel)", () => {
    expect(catalogModel("claude-sonnet-5")?.provider).toBe("anthropic");
    expect(catalogModel("gemini-3.8-flash")?.provider).toBe("gemini");
  });

  it("looks models up by exact id and names the providers", () => {
    expect(catalogModel("claude-opus-5-5")?.label).toBe("Claude Opus 5.5");
    expect(catalogModel("claude-opus-5-5-20260901")).toBeUndefined();
    expect(catalogModel("gpt-x")).toBeUndefined();
    expect(PROVIDER_LABELS).toEqual({ anthropic: "Anthropic", gemini: "Google Gemini", fake: "Development" });
  });

  it("the ./catalog and ./pricing entry points load no provider SDK (the API imports them)", () => {
    for (const file of ["./catalog.ts", "./pricing.ts"]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      const imports = [...source.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"([^"]+)"/gm)].map((m) => `${m[1] ? "type " : ""}${m[2]}`);
      expect(imports.every((i) => i === "type @platform/contracts"), `${file}: ${imports.join(", ")}`).toBe(true);
    }
  });
});
