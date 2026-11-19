import type { RerunOutcome, RerunResult } from "@platform/contracts";

/**
 * A failed rerun runs once more (2026-11-19): a disagreement between exploration and one rerun was reported as
 * DISCOVERY_RERUN_DISAGREE whether the test was wrong or only unsteady. Two attempts tell them apart: the same outcome
 * twice stands; a pass and a failure is FLAKY (reconciled INCONCLUSIVE / RERUN_FLAKY).
 */

const decided = (o: RerunOutcome | undefined): o is "PASSED" | "ASSERTION_FAILED" => o === "PASSED" || o === "ASSERTION_FAILED";

/** Each criterion's outcome over two attempts. */
export function combineAttempts(first: Record<string, RerunOutcome>, second: Record<string, RerunOutcome>): Record<string, RerunOutcome> {
  const out: Record<string, RerunOutcome> = {};
  for (const id of new Set([...Object.keys(first), ...Object.keys(second)])) {
    const a = first[id];
    const b = second[id];
    if (a === undefined || b === undefined) out[id] = (a ?? b)!;
    else if (a === b) out[id] = a;
    else if (decided(a) && decided(b)) out[id] = "FLAKY";
    else if (decided(a)) out[id] = a;
    else out[id] = b;
  }
  return out;
}

/** The status of a rerun with these outcomes: FAILED when an assertion failed or was flaky, else the last attempt's. */
export function rerunStatusOf(perCriterion: Record<string, RerunOutcome>, last: RerunResult["status"]): RerunResult["status"] {
  return Object.values(perCriterion).some((o) => o === "ASSERTION_FAILED" || o === "FLAKY") ? "FAILED" : last;
}
