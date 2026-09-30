import type { CriterionStatus, RunVerdict } from "@platform/contracts";

/**
 * Section 2.4 — first matching rule wins, over the critical criteria only (V1.1, D4 amended): a non-critical
 * result never changes the verdict. `critical` absent means critical (every result before V1.1). With no
 * critical result at all (the contract forbids it), every result counts. A requirement always has ≥ 1 criterion.
 */
export function aggregateVerdict(all: readonly { status: CriterionStatus; critical?: boolean }[]): RunVerdict {
  if (all.length === 0) throw new Error("aggregateVerdict requires at least one criterion");
  const critical = all.filter((r) => r.critical !== false);
  const results = critical.length > 0 ? critical : all;
  if (results.some((r) => r.status === "FAIL")) return "FAILED";
  if (results.some((r) => r.status === "BLOCKED")) return "BLOCKED";
  if (results.some((r) => r.status === "INCONCLUSIVE")) return "INCONCLUSIVE";
  return "PASSED";
}
