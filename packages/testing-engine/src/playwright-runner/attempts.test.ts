import { describe, expect, it } from "vitest";
import { combineAttempts, rerunStatusOf } from "./attempts";

describe("combineAttempts (2026-11-19)", () => {
  it.each([
    ["PASSED", "PASSED", "PASSED"],
    ["ASSERTION_FAILED", "ASSERTION_FAILED", "ASSERTION_FAILED"],
    ["PASSED", "ASSERTION_FAILED", "FLAKY"],
    ["ASSERTION_FAILED", "PASSED", "FLAKY"],
    ["NOT_REACHED", "PASSED", "PASSED"],
    ["ASSERTION_FAILED", "NOT_REACHED", "ASSERTION_FAILED"],
    ["UNAVAILABLE", "ASSERTION_FAILED", "ASSERTION_FAILED"],
    ["NOT_REACHED", "NOT_REACHED", "NOT_REACHED"],
    ["NOT_REACHED", "UNAVAILABLE", "UNAVAILABLE"],
  ] as const)("%s then %s → %s", (a, b, combined) => {
    expect(combineAttempts({ "AC-1": a }, { "AC-1": b })).toEqual({ "AC-1": combined });
  });

  it("two identical failures stay ASSERTION_FAILED, a criterion only one attempt has keeps its outcome", () => {
    expect(combineAttempts({ "AC-1": "ASSERTION_FAILED", "AC-2": "PASSED" }, { "AC-1": "ASSERTION_FAILED" })).toEqual({ "AC-1": "ASSERTION_FAILED", "AC-2": "PASSED" });
  });
});

describe("rerunStatusOf", () => {
  it("FAILED when any assertion failed or was flaky, else the second attempt's status", () => {
    expect(rerunStatusOf({ "AC-1": "PASSED", "AC-2": "FLAKY" }, "PASSED")).toBe("FAILED");
    expect(rerunStatusOf({ "AC-1": "ASSERTION_FAILED" }, "ERRORED")).toBe("FAILED");
    expect(rerunStatusOf({ "AC-1": "PASSED" }, "PASSED")).toBe("PASSED");
    expect(rerunStatusOf({ "AC-1": "NOT_REACHED" }, "ERRORED")).toBe("ERRORED");
  });
});
