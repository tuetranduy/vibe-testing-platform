import type { CriterionStatus, RunVerdict } from "@platform/contracts";
import { describe, expect, it } from "vitest";
import { compareResults, runChange, type ComparableRun } from "./comparison";

const run = (verdict: RunVerdict | null, criteria: [string, string, CriterionStatus, boolean?][]): ComparableRun => ({
  verdict,
  criteria: criteria.map(([id, description, status, critical = true]) => ({ id, description, status, critical })),
  durationMs: 1000,
  costUsd: 0.01,
});

describe("compareResults (V1.2 F2)", () => {
  it("classifies each status change: fixed, regressed, changed, unchanged", () => {
    const before = run("FAILED", [
      ["AC-1", "Cart count is 1", "FAIL"],
      ["AC-2", "Total is shown", "PASS"],
      ["AC-3", "Banner is hidden", "BLOCKED"],
      ["AC-4", "Title is Shop", "PASS"],
    ]);
    const after = run("FAILED", [
      ["AC-1", "Cart count is 1", "PASS"],
      ["AC-2", "Total is shown", "FAIL"],
      ["AC-3", "Banner is hidden", "INCONCLUSIVE"],
      ["AC-4", "Title is Shop", "PASS"],
    ]);
    const c = compareResults(before, after);
    expect(c.criteria.map((x) => [x.id, x.before, x.after, x.change])).toEqual([
      ["AC-1", "FAIL", "PASS", "fixed"],
      ["AC-2", "PASS", "FAIL", "regressed"],
      ["AC-3", "BLOCKED", "INCONCLUSIVE", "changed"],
      ["AC-4", "PASS", "PASS", "unchanged"],
    ]);
    expect(c.counts).toEqual({ regressed: 1, fixed: 1, changed: 1, unchanged: 1, added: 0, removed: 0 });
    expect(c.verdict).toEqual({ before: "FAILED", after: "FAILED" });
  });

  it("matches renumbered criteria by wording (whitespace and case aside); the rest are added or removed", () => {
    const before = run("PASSED", [
      ["AC-1", "Cart count is 1", "PASS"],
      ["AC-2", "The  total is shown", "PASS"],
      ["AC-3", "Old criterion", "PASS"],
    ]);
    const after = run("PASSED", [
      ["AC-1", "the total is SHOWN", "PASS"],
      ["AC-2", "Cart count is 1", "PASS"],
      ["AC-3", "New criterion", "PASS"],
    ]);
    const c = compareResults(before, after);
    expect(c.criteria.map((x) => [x.id, x.before, x.change])).toEqual([
      ["AC-1", "PASS", "unchanged"],
      ["AC-2", "PASS", "unchanged"],
      ["AC-3", null, "added"],
      ["AC-3", "PASS", "removed"],
    ]);
    expect(c.criteria.at(-1)).toMatchObject({ description: "Old criterion", after: null });
  });

  it("without a baseline every criterion is added", () => {
    const c = compareResults(null, run("PASSED", [["AC-1", "x", "PASS"]]));
    expect(c.criteria[0]).toMatchObject({ before: null, change: "added" });
    expect(c.verdict.before).toBeNull();
    expect(c.durationMs).toEqual({ before: null, after: 1000 });
  });
});

describe("runChange", () => {
  const cmp = (b: ComparableRun, a: ComparableRun) => compareResults(b, a);
  it("names the whole run's change", () => {
    const pass = run("PASSED", [["AC-1", "x", "PASS"]]);
    const fail = run("FAILED", [["AC-1", "x", "FAIL"]]);
    expect(runChange(cmp(pass, pass), true)).toBe("unchanged");
    expect(runChange(cmp(pass, fail), true)).toBe("regressed");
    expect(runChange(cmp(fail, pass), true)).toBe("fixed");
    expect(runChange(cmp(pass, pass), false)).toBe("new");
    // A non-critical criterion that regresses changes the run, but it is not a regression.
    const nonCritical = run("PASSED", [["AC-1", "x", "PASS"], ["AC-2", "y", "PASS", false]]);
    const nonCriticalFails = run("PASSED", [["AC-1", "x", "PASS"], ["AC-2", "y", "FAIL", false]]);
    expect(runChange(cmp(nonCritical, nonCriticalFails), true)).toBe("changed");
    expect(runChange(cmp(run("BLOCKED", [["AC-1", "x", "BLOCKED"]]), run("INCONCLUSIVE", [["AC-1", "x", "INCONCLUSIVE"]])), true)).toBe("changed");
  });
});
