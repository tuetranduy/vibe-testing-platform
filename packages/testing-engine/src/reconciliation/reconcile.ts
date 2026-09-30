import {
  CriterionResultSchema,
  type CriterionResult,
  type FactRef,
  type ObservedFact,
  type ProvisionalResult,
  type RerunOutcome,
  type StatusReason,
  type VerdictSource,
} from "@platform/contracts";

export interface ReconcileExtras {
  evidenceArtifactIds: string[];
  relatedStepIds: string[];
  /** Semantic judge note (D3); never affects the status. */
  aiNote: string | null;
  /** The criterion's weight (V1.1); absent: critical. Never affects the status, only the verdict. */
  critical?: boolean;
}

const refKey = (ref: FactRef) => `${ref.key}@${ref.checkpoint}`;

/**
 * Reconciliation (Task 18, Section 2.3): a criterion's final status from its provisional result (the
 * verifier, after exploration) and the rerun outcome of its assertion. Pure — no I/O, no model.
 *
 * | Provisional   | Rerun outcome                                   | Final         | verdictSource    | Reason                   |
 * |---------------|-------------------------------------------------|---------------|------------------|--------------------------|
 * | BLOCKED       | any                                             | BLOCKED       | —                | unchanged                |
 * | INCONCLUSIVE  | any                                             | INCONCLUSIVE  | —                | unchanged                |
 * | PASS          | PASSED                                          | PASS          | PLAYWRIGHT_RERUN | —                        |
 * | FAIL          | ASSERTION_FAILED                                | FAIL          | PLAYWRIGHT_RERUN | —                        |
 * | PASS          | ASSERTION_FAILED                                | INCONCLUSIVE  | —                | DISCOVERY_RERUN_DISAGREE |
 * | FAIL          | PASSED                                          | INCONCLUSIVE  | —                | DISCOVERY_RERUN_DISAGREE |
 * | PASS / FAIL   | NOT_REACHED / UNAVAILABLE, all DOM_VERIFIED     | provisional   | EXPLORATION_ONLY | —                        |
 * | PASS / FAIL   | NOT_REACHED / UNAVAILABLE, else                 | INCONCLUSIVE  | —                | UNVERIFIED_EVIDENCE      |
 *
 * "All DOM_VERIFIED" is strict: the criterion references at least one fact, and every referenced fact
 * was recorded and read from the DOM. A missing fact counts as unverified. When a key@checkpoint was
 * recorded more than once, the last reading is the one the verifier used, so it is the one that counts.
 * Consequence: no PASS exists without deterministic evidence. (Replaces the interim R26 rule, R35.)
 */
export function reconcile(
  provisional: ProvisionalResult,
  rerun: RerunOutcome,
  facts: readonly ObservedFact[],
  extras: ReconcileExtras,
): CriterionResult {
  const final = decide(provisional, rerun, facts);
  return CriterionResultSchema.parse({
    ...provisional,
    status: final.status,
    reason: final.reason,
    verdictSource: final.verdictSource,
    rerunOutcome: rerun,
    provisional: { status: provisional.status, reason: provisional.reason },
    evidenceArtifactIds: extras.evidenceArtifactIds,
    relatedStepIds: extras.relatedStepIds,
    aiNote: extras.aiNote,
    critical: extras.critical ?? true,
  });
}

interface Decision {
  status: ProvisionalResult["status"];
  reason: StatusReason | null;
  verdictSource: VerdictSource | null;
}

function decide(p: ProvisionalResult, rerun: RerunOutcome, facts: readonly ObservedFact[]): Decision {
  if (p.status === "BLOCKED" || p.status === "INCONCLUSIVE") return { status: p.status, reason: p.reason, verdictSource: null };

  const confirms = p.status === "PASS" ? "PASSED" : "ASSERTION_FAILED";
  const contradicts = p.status === "PASS" ? "ASSERTION_FAILED" : "PASSED";
  if (rerun === confirms) return { status: p.status, reason: null, verdictSource: "PLAYWRIGHT_RERUN" };
  if (rerun === contradicts) return { status: "INCONCLUSIVE", reason: "DISCOVERY_RERUN_DISAGREE", verdictSource: null };

  // NOT_REACHED / UNAVAILABLE: the exploration's evidence alone must be deterministic.
  return domVerified(p.factRefs, facts)
    ? { status: p.status, reason: null, verdictSource: "EXPLORATION_ONLY" }
    : { status: "INCONCLUSIVE", reason: "UNVERIFIED_EVIDENCE", verdictSource: null };
}

function domVerified(refs: readonly FactRef[], facts: readonly ObservedFact[]): boolean {
  const latest = new Map<string, ObservedFact>();
  for (const f of facts) latest.set(refKey(f), f);
  return refs.length > 0 && refs.every((ref) => latest.get(refKey(ref))?.provenance === "DOM_VERIFIED");
}
