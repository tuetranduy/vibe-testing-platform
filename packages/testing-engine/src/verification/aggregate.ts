import type { CriterionStatus, RunVerdict } from "@platform/contracts";

/** Section 2.4 — first matching rule wins. A requirement always has ≥ 1 criterion. */
export function aggregateVerdict(results: readonly { status: CriterionStatus }[]): RunVerdict {
  if (results.length === 0) throw new Error("aggregateVerdict requires at least one criterion");
  if (results.some((r) => r.status === "FAIL")) return "FAILED";
  if (results.some((r) => r.status === "BLOCKED")) return "BLOCKED";
  if (results.some((r) => r.status === "INCONCLUSIVE")) return "INCONCLUSIVE";
  return "PASSED";
}
