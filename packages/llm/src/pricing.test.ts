import { describe, expect, it } from "vitest";
import { estimateCostUsd, priceFor } from "./pricing";

describe("priceFor", () => {
  it("matches exact ids", () => {
    expect(priceFor("claude-sonnet-5")).toEqual({ inputUsdPerMTok: 2, outputUsdPerMTok: 10 });
  });
  it("matches dated / suffixed snapshot ids by longest known prefix", () => {
    expect(priceFor("claude-sonnet-5-20260401")).toEqual(priceFor("claude-sonnet-5"));
    expect(priceFor("claude-opus-5-5-20260901")).toEqual({ inputUsdPerMTok: 4, outputUsdPerMTok: 20 });
    expect(priceFor("claude-opus-5-20260401")).toEqual({ inputUsdPerMTok: 5, outputUsdPerMTok: 25 });
    expect(priceFor("claude-haiku-4-5@20251001")).toEqual(priceFor("claude-haiku-4-5"));
  });
  it("does not match on a partial token", () => {
    expect(priceFor("claude-sonnet-50")).toBeNull();
  });
  it("returns null for unknown models", () => {
    expect(priceFor("gpt-x")).toBeNull();
    expect(estimateCostUsd("gpt-x", 1000, 1000)).toBeNull();
  });
  it("estimates cost per million tokens", () => {
    expect(estimateCostUsd("claude-sonnet-5", 1000, 500)).toBe(0.007);
  });
  it("prices Gemini models, each variant at its own price", () => {
    expect(estimateCostUsd("gemini-3.8-flash", 1000, 500, new Date("2026-09-27T12:00:00Z"))).toBe(0.002625);
    // Not gemini-3.5-flash's price through the snapshot-prefix rule.
    expect(priceFor("gemini-3.5-flash-lite")).toEqual({ inputUsdPerMTok: 0.3, outputUsdPerMTok: 2.5 });
    // The ≤200k-token prompt tier.
    expect(priceFor("gemini-3.1-pro-preview")).toEqual({ inputUsdPerMTok: 2, outputUsdPerMTok: 12 });
  });
  it("switches to a price announced for a later date on that date (UTC): Gemini 3.6–3.8 Flash double on 2027-01-01", () => {
    const before = new Date("2026-12-31T23:59:59Z");
    const after = new Date("2027-01-01T00:00:00Z");
    for (const model of ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash"]) {
      expect(priceFor(model, before), model).toEqual({ inputUsdPerMTok: 0.75, outputUsdPerMTok: 3.75 });
      expect(priceFor(model, after), model).toEqual({ inputUsdPerMTok: 1.5, outputUsdPerMTok: 7.5 });
    }
    // A snapshot id follows its model's dates too.
    expect(estimateCostUsd("gemini-3.8-flash-001", 1000, 500, after)).toBe(0.00525);
  });
});
