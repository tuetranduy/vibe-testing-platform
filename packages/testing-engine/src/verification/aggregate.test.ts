import type { CriterionStatus, RunVerdict } from "@platform/contracts";
import { describe, expect, it } from "vitest";
import { aggregateVerdict } from "./aggregate";

const s = (...statuses: CriterionStatus[]) => statuses.map((status) => ({ status }));

describe("aggregateVerdict (Section 2.4)", () => {
  it.each<[CriterionStatus[], RunVerdict]>([
    [["FAIL", "BLOCKED"], "FAILED"],
    [["FAIL", "PASS", "INCONCLUSIVE"], "FAILED"],
    [["BLOCKED", "INCONCLUSIVE"], "BLOCKED"],
    [["BLOCKED", "PASS"], "BLOCKED"],
    [["PASS", "INCONCLUSIVE"], "INCONCLUSIVE"],
    [["INCONCLUSIVE"], "INCONCLUSIVE"],
    [["PASS", "PASS"], "PASSED"],
    [["PASS"], "PASSED"],
    [["FAIL"], "FAILED"],
    [["INCONCLUSIVE", "BLOCKED", "FAIL"], "FAILED"],
    [["BLOCKED"], "BLOCKED"],
    [["INCONCLUSIVE", "PASS", "BLOCKED"], "BLOCKED"],
    [["INCONCLUSIVE", "INCONCLUSIVE"], "INCONCLUSIVE"],
    [["PASS", "PASS", "PASS"], "PASSED"],
  ])("%j → %s", (statuses, verdict) => {
    expect(aggregateVerdict(s(...statuses))).toBe(verdict);
  });

  it("rejects an empty list", () => {
    expect(() => aggregateVerdict([])).toThrow();
  });
});

describe("aggregateVerdict with weights (V1.1, D4 amended)", () => {
  it("decides from the critical criteria only", () => {
    expect(aggregateVerdict([{ status: "PASS" }, { status: "FAIL", critical: false }])).toBe("PASSED");
    expect(aggregateVerdict([{ status: "INCONCLUSIVE", critical: true }, { status: "FAIL", critical: false }])).toBe("INCONCLUSIVE");
    expect(aggregateVerdict([{ status: "PASS", critical: true }, { status: "BLOCKED", critical: false }])).toBe("PASSED");
    expect(aggregateVerdict([{ status: "FAIL", critical: true }, { status: "PASS", critical: false }])).toBe("FAILED");
  });

  it("treats a result without a weight as critical (results before V1.1)", () => {
    expect(aggregateVerdict([{ status: "FAIL" }, { status: "PASS", critical: false }])).toBe("FAILED");
  });

  it("falls back to every result when none is critical (the contract forbids it)", () => {
    expect(aggregateVerdict([{ status: "FAIL", critical: false }])).toBe("FAILED");
  });
});
