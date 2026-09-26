import {
  CriterionResultSchema,
  type FactRef,
  type ObservedFact,
  type ProvisionalResult,
  type RerunOutcome,
} from "@platform/contracts";
import { describe, expect, it } from "vitest";
import { reconcile } from "./reconcile";

const before = { key: "cartCount", checkpoint: "before_add" };
const after = { key: "cartCount", checkpoint: "after_add" };
const element = { candidates: [{ strategy: "testId" as const, value: "cart-count" }], chosenIndex: 0, framePath: [] };

const fact = (ref: FactRef, provenance: ObservedFact["provenance"], stepId = "st_1"): ObservedFact => ({
  ...ref,
  value: 1,
  provenance,
  read: provenance === "DOM_VERIFIED" ? { element, mode: "number" } : null,
  stepId,
});
const provisional = (status: ProvisionalResult["status"], reason: ProvisionalResult["reason"] = null, factRefs: FactRef[] = [after, before]): ProvisionalResult => ({
  criterionId: "AC-1",
  status,
  reason,
  factRefs,
  expected: "Cart count after add > before add",
  actual: status === "PASS" || status === "FAIL" ? "Cart count after add (1) > before add (0)" : null,
});
const extras = { evidenceArtifactIds: ["art_1"], relatedStepIds: ["st_1"], aiNote: null };
const dom = [fact(before, "DOM_VERIFIED"), fact(after, "DOM_VERIFIED")];
const mixed = [fact(before, "DOM_VERIFIED"), fact(after, "MODEL_EXTRACTED")];
const OUTCOMES: RerunOutcome[] = ["PASSED", "ASSERTION_FAILED", "NOT_REACHED", "UNAVAILABLE"];

type Row = {
  row: string;
  provisional: ProvisionalResult;
  rerun: RerunOutcome;
  facts: ObservedFact[];
  status: ProvisionalResult["status"];
  verdictSource: "PLAYWRIGHT_RERUN" | "EXPLORATION_ONLY" | null;
  reason: ProvisionalResult["reason"];
};

/** Section 2.3, one case per row (rows with "any" / alternatives expanded over every value). */
const TABLE: Row[] = [
  ...OUTCOMES.map((rerun): Row => ({
    row: "BLOCKED | any → BLOCKED, unchanged",
    provisional: provisional("BLOCKED", "MISSING_SECRET"),
    rerun,
    facts: dom,
    status: "BLOCKED",
    verdictSource: null,
    reason: "MISSING_SECRET",
  })),
  ...OUTCOMES.map((rerun): Row => ({
    row: "INCONCLUSIVE | any → INCONCLUSIVE, unchanged",
    provisional: provisional("INCONCLUSIVE", "FACT_NOT_OBSERVED"),
    rerun,
    facts: dom,
    status: "INCONCLUSIVE",
    verdictSource: null,
    reason: "FACT_NOT_OBSERVED",
  })),
  { row: "PASS | PASSED → PASS / PLAYWRIGHT_RERUN", provisional: provisional("PASS"), rerun: "PASSED", facts: dom, status: "PASS", verdictSource: "PLAYWRIGHT_RERUN", reason: null },
  { row: "FAIL | ASSERTION_FAILED → FAIL / PLAYWRIGHT_RERUN", provisional: provisional("FAIL"), rerun: "ASSERTION_FAILED", facts: dom, status: "FAIL", verdictSource: "PLAYWRIGHT_RERUN", reason: null },
  { row: "PASS | ASSERTION_FAILED → INCONCLUSIVE / DISCOVERY_RERUN_DISAGREE", provisional: provisional("PASS"), rerun: "ASSERTION_FAILED", facts: dom, status: "INCONCLUSIVE", verdictSource: null, reason: "DISCOVERY_RERUN_DISAGREE" },
  { row: "FAIL | PASSED → INCONCLUSIVE / DISCOVERY_RERUN_DISAGREE", provisional: provisional("FAIL"), rerun: "PASSED", facts: dom, status: "INCONCLUSIVE", verdictSource: null, reason: "DISCOVERY_RERUN_DISAGREE" },
  ...(["PASS", "FAIL"] as const).flatMap((status) =>
    (["NOT_REACHED", "UNAVAILABLE"] as const).map((rerun): Row => ({
      row: `${status} | ${rerun}, all facts DOM_VERIFIED → ${status} / EXPLORATION_ONLY`,
      provisional: provisional(status),
      rerun,
      facts: dom,
      status,
      verdictSource: "EXPLORATION_ONLY",
      reason: null,
    })),
  ),
  ...(["PASS", "FAIL"] as const).flatMap((status) =>
    (["NOT_REACHED", "UNAVAILABLE"] as const).map((rerun): Row => ({
      row: `${status} | ${rerun}, a MODEL_EXTRACTED fact → INCONCLUSIVE / UNVERIFIED_EVIDENCE`,
      provisional: provisional(status),
      rerun,
      facts: mixed,
      status: "INCONCLUSIVE",
      verdictSource: null,
      reason: "UNVERIFIED_EVIDENCE",
    })),
  ),
];

describe("reconcile (Section 2.3)", () => {
  it.each(TABLE.map((r) => [`${r.row} (rerun ${r.rerun})`, r] as const))("%s", (_name, r) => {
    const result = reconcile(r.provisional, r.rerun, r.facts, extras);
    expect(CriterionResultSchema.parse(result)).toEqual(result);
    expect(result).toEqual({
      ...r.provisional,
      status: r.status,
      reason: r.reason,
      verdictSource: r.verdictSource,
      rerunOutcome: r.rerun,
      provisional: { status: r.provisional.status, reason: r.provisional.reason },
      evidenceArtifactIds: ["art_1"],
      relatedStepIds: ["st_1"],
      aiNote: null,
    });
  });

  it("covers every (provisional status × rerun outcome) pair", () => {
    const pairs = new Set(TABLE.map((r) => `${r.provisional.status}|${r.rerun}`));
    expect(pairs.size).toBe(16);
  });
});

describe("reconcile: EXPLORATION_ONLY needs deterministic evidence (no PASS without it)", () => {
  it.each(["NOT_REACHED", "UNAVAILABLE"] as const)("a PASS with rerun %s stands only when every referenced fact is DOM_VERIFIED", (rerun) => {
    expect(reconcile(provisional("PASS"), rerun, dom, extras)).toMatchObject({ status: "PASS", verdictSource: "EXPLORATION_ONLY" });
    expect(reconcile(provisional("PASS"), rerun, mixed, extras)).toMatchObject({ status: "INCONCLUSIVE", reason: "UNVERIFIED_EVIDENCE", verdictSource: null });
  });

  it("one MODEL_EXTRACTED fact among several → INCONCLUSIVE / UNVERIFIED_EVIDENCE", () => {
    const title = { key: "pageTitle", checkpoint: "after_add" };
    const facts = [...dom, fact(title, "MODEL_EXTRACTED")];
    const r = reconcile(provisional("PASS", null, [after, before, title]), "UNAVAILABLE", facts, extras);
    expect(r).toMatchObject({ status: "INCONCLUSIVE", reason: "UNVERIFIED_EVIDENCE", provisional: { status: "PASS", reason: null } });
  });

  it("a MODEL_EXTRACTED fact the criterion does not reference does not matter", () => {
    const facts = [...dom, fact({ key: "cartItems", checkpoint: "cart_page" }, "MODEL_EXTRACTED")];
    expect(reconcile(provisional("FAIL"), "NOT_REACHED", facts, extras)).toMatchObject({ status: "FAIL", verdictSource: "EXPLORATION_ONLY" });
  });

  it("a referenced fact that was never recorded → UNVERIFIED_EVIDENCE", () => {
    expect(reconcile(provisional("PASS"), "UNAVAILABLE", [fact(before, "DOM_VERIFIED")], extras)).toMatchObject({
      status: "INCONCLUSIVE",
      reason: "UNVERIFIED_EVIDENCE",
    });
  });

  it("a PASS with no fact refs has no deterministic evidence → UNVERIFIED_EVIDENCE", () => {
    expect(reconcile(provisional("PASS", null, []), "UNAVAILABLE", dom, extras)).toMatchObject({ status: "INCONCLUSIVE", reason: "UNVERIFIED_EVIDENCE" });
  });

  it("uses the fact the verifier used: the last one recorded for a key@checkpoint", () => {
    const reread = [fact(before, "DOM_VERIFIED"), fact(after, "MODEL_EXTRACTED"), fact(after, "DOM_VERIFIED")];
    expect(reconcile(provisional("PASS"), "UNAVAILABLE", reread, extras)).toMatchObject({ status: "PASS", verdictSource: "EXPLORATION_ONLY" });
    const worse = [fact(before, "DOM_VERIFIED"), fact(after, "DOM_VERIFIED"), fact(after, "MODEL_EXTRACTED")];
    expect(reconcile(provisional("PASS"), "UNAVAILABLE", worse, extras)).toMatchObject({ status: "INCONCLUSIVE", reason: "UNVERIFIED_EVIDENCE" });
  });
});

describe("reconcile: record keeping", () => {
  it("keeps expected / actual / factRefs and passes the extras (evidence, related steps, AI note) through", () => {
    const r = reconcile(provisional("FAIL"), "ASSERTION_FAILED", dom, { evidenceArtifactIds: ["art_t", "art_s"], relatedStepIds: ["st_2", "st_3"], aiNote: "note" });
    expect(r).toMatchObject({
      expected: "Cart count after add > before add",
      actual: "Cart count after add (1) > before add (0)",
      factRefs: [after, before],
      evidenceArtifactIds: ["art_t", "art_s"],
      relatedStepIds: ["st_2", "st_3"],
      aiNote: "note",
    });
  });

  it("an AI note never changes a status: a semantic criterion stays INCONCLUSIVE / AI_JUDGED_ONLY", () => {
    const semantic = provisional("INCONCLUSIVE", "AI_JUDGED_ONLY", []);
    for (const rerun of OUTCOMES) {
      expect(reconcile(semantic, rerun, dom, { ...extras, aiNote: "Looks fine to the model" })).toMatchObject({
        status: "INCONCLUSIVE",
        reason: "AI_JUDGED_ONLY",
        verdictSource: null,
        aiNote: "Looks fine to the model",
      });
    }
  });
});
