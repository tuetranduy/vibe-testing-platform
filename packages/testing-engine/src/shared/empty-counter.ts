import type { ExpectedOutcome, FactRef } from "@platform/contracts";

/**
 * Empty DOM counters can represent zero (KI-060). Keep the existing delta behavior and apply it
 * to comparisons of explicitly named counts/quantities, never arbitrary numeric values such as
 * prices. The verifier still requires a DOM-verified number read from a located element; the
 * generated test uses the same policy and does not turn a missing element into zero.
 */
export function usesEmptyCounterZero(outcome: ExpectedOutcome, ref: FactRef): boolean {
  if (outcome.kind === "numeric_delta") return true;
  if (outcome.kind !== "numeric_compare") return false;
  const words = ref.key.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return /(?:^|[\s_.-])(?:count|quantity|qty)(?:$|[\s_.-])/i.test(words);
}
