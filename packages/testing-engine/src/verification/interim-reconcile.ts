import type { FactRef, ObservedFact, ProvisionalResult } from "@platform/contracts";

/**
 * INTERIM — Ruling R26, replaced by Task 18's reconciliation.
 *
 * Until the Playwright rerun exists, every run is in Section 2.3's no-rerun rows: a provisional
 * PASS/FAIL stands (as EXPLORATION_ONLY) only if every fact behind it was read from the DOM
 * (DOM_VERIFIED); any MODEL_EXTRACTED or missing fact — or no fact at all — makes it
 * INCONCLUSIVE / UNVERIFIED_EVIDENCE. BLOCKED and INCONCLUSIVE are unchanged. Keeps "no PASS without
 * deterministic evidence" true in Milestone B.
 */
export function applyNoRerunEvidenceRule(results: readonly ProvisionalResult[], facts: readonly ObservedFact[]): ProvisionalResult[] {
  const key = (r: FactRef) => `${r.key}@${r.checkpoint}`;
  const provenance = new Map(facts.map((f) => [key(f), f.provenance]));
  return results.map((r) => {
    if (r.status !== "PASS" && r.status !== "FAIL") return r;
    const deterministic = r.factRefs.length > 0 && r.factRefs.every((ref) => provenance.get(key(ref)) === "DOM_VERIFIED");
    return deterministic ? r : { ...r, status: "INCONCLUSIVE", reason: "UNVERIFIED_EVIDENCE" };
  });
}
