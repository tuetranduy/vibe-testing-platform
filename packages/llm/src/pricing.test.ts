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
});
