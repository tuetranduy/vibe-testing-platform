// @vitest-environment node
import { BlockReasonSchema, CriterionStatusSchema, InconclusiveReasonSchema, RunVerdictSchema } from "@platform/contracts";
import { describe, expect, it } from "vitest";
import { CRITERION_STATUS_UI, STATUS_REASON_TEXT, VERDICT_UI, formatDuration, formatUsd, hostOf, reasonText } from "./report-format";

describe("report formatting", () => {
  it("maps every BLOCKED and INCONCLUSIVE reason in the contracts to plain language", () => {
    const reasons = [...BlockReasonSchema.options, ...InconclusiveReasonSchema.options];
    for (const r of reasons) {
      const text = STATUS_REASON_TEXT[r];
      expect(text, r).toBeTruthy();
      expect(text, r).not.toMatch(/[A-Z]{2,}_[A-Z]/); // no raw enum codes
    }
    expect(Object.keys(STATUS_REASON_TEXT).sort()).toEqual([...reasons].sort()); // nothing extra, nothing missing
    expect(new Set(reasons.map((r) => STATUS_REASON_TEXT[r])).size).toBe(reasons.length);
    expect(STATUS_REASON_TEXT.MISSING_SECRET).toBe("A secret this check needs (for example a password) was not provided");
  });

  it("has a fallback when a result carries no reason", () => {
    expect(reasonText(null)).toMatch(/no reason was recorded/i);
  });

  it("gives every criterion status and run verdict a distinct label, icon and tone", () => {
    for (const ui of [CRITERION_STATUS_UI, VERDICT_UI]) {
      const all = Object.values(ui);
      for (const key of ["label", "icon", "tone"] as const) expect(new Set(all.map((u) => u[key])).size).toBe(all.length);
    }
    expect(Object.keys(CRITERION_STATUS_UI).sort()).toEqual([...CriterionStatusSchema.options].sort());
    expect(Object.keys(VERDICT_UI).sort()).toEqual([...RunVerdictSchema.options].sort());
    // A BLOCKED / INCONCLUSIVE result is never presented like a failure.
    for (const s of ["BLOCKED", "INCONCLUSIVE"] as const) {
      expect(CRITERION_STATUS_UI[s].tone).not.toBe(CRITERION_STATUS_UI.FAIL.tone);
      expect(VERDICT_UI[s].tone).not.toBe(VERDICT_UI.FAILED.tone);
    }
  });

  it("formats durations", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(400)).toBe("< 1s");
    expect(formatDuration(42_400)).toBe("42s");
    expect(formatDuration(95_000)).toBe("1m 35s");
    expect(formatDuration(3_600_000 + 120_000)).toBe("1h 2m");
  });

  it("formats an estimated cost sensibly at every size", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.0421)).toBe("$0.042");
    expect(formatUsd(0.00004)).toBe("< $0.001");
    expect(formatUsd(1.234)).toBe("$1.23");
    expect(formatUsd(0.5)).toBe("$0.50");
  });

  it("extracts a host from a target URL", () => {
    expect(hostOf("https://shop.example.com:8443/path?q=1")).toBe("shop.example.com:8443");
    expect(hostOf("not a url")).toBe("not a url");
  });
});
