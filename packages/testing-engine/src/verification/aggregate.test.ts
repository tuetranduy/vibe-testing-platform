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
  ])("%j → %s", (statuses, verdict) => {
    expect(aggregateVerdict(s(...statuses))).toBe(verdict);
  });

  it("rejects an empty list", () => {
    expect(() => aggregateVerdict([])).toThrow();
  });
});
