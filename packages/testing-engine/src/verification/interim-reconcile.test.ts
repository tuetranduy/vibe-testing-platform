import type { FactRef, ObservedFact, ProvisionalResult } from "@platform/contracts";
import { describe, expect, it } from "vitest";
import { applyNoRerunEvidenceRule } from "./interim-reconcile";

const before = { key: "cartCount", checkpoint: "before_add" };
const after = { key: "cartCount", checkpoint: "after_add" };
const element = { candidates: [{ strategy: "testId" as const, value: "cart-count" }], chosenIndex: 0, framePath: [] };

const fact = (ref: FactRef, provenance: ObservedFact["provenance"]): ObservedFact => ({
  ...ref,
  value: 1,
  provenance,
  read: provenance === "DOM_VERIFIED" ? { element, mode: "number" } : null,
  stepId: "st_1",
});
const result = (status: ProvisionalResult["status"], factRefs: FactRef[], reason: ProvisionalResult["reason"] = null): ProvisionalResult => ({
  criterionId: "AC-1",
  status,
  reason,
  factRefs,
  expected: "Cart count after add > before add",
  actual: status === "PASS" || status === "FAIL" ? "Cart count after add (1) > before add (0)" : null,
});

describe("applyNoRerunEvidenceRule (interim Section 2.3 no-rerun rows, Ruling R26)", () => {
  const dom = [fact(before, "DOM_VERIFIED"), fact(after, "DOM_VERIFIED")];
  const mixed = [fact(before, "DOM_VERIFIED"), fact(after, "MODEL_EXTRACTED")];

  it.each(["PASS", "FAIL"] as const)("%s with every fact DOM_VERIFIED stands", (status) => {
    const r = result(status, [after, before]);
    expect(applyNoRerunEvidenceRule([r], dom)).toEqual([r]);
  });

  it.each(["PASS", "FAIL"] as const)("%s with any MODEL_EXTRACTED fact → INCONCLUSIVE / UNVERIFIED_EVIDENCE", (status) => {
    expect(applyNoRerunEvidenceRule([result(status, [after, before])], mixed)).toEqual([
      { ...result(status, [after, before]), status: "INCONCLUSIVE", reason: "UNVERIFIED_EVIDENCE" },
    ]);
  });

  it("a PASS whose fact is missing → UNVERIFIED_EVIDENCE", () => {
    expect(applyNoRerunEvidenceRule([result("PASS", [after, before])], [fact(before, "DOM_VERIFIED")])[0]).toMatchObject({
      status: "INCONCLUSIVE",
      reason: "UNVERIFIED_EVIDENCE",
    });
  });

  it("a PASS with no fact refs has no deterministic evidence → UNVERIFIED_EVIDENCE", () => {
    expect(applyNoRerunEvidenceRule([result("PASS", [])], dom)[0]).toMatchObject({ status: "INCONCLUSIVE", reason: "UNVERIFIED_EVIDENCE" });
  });

  it("BLOCKED and INCONCLUSIVE are unchanged", () => {
    const blocked = result("BLOCKED", [after], "MISSING_SECRET");
    const inconclusive = result("INCONCLUSIVE", [after], "FACT_NOT_OBSERVED");
    expect(applyNoRerunEvidenceRule([blocked, inconclusive], mixed)).toEqual([blocked, inconclusive]);
  });
});
