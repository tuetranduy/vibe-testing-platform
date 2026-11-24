import { describe, expect, it } from "vitest";
import { discoveryOutcomeText } from "./discovery";

const base = { candidateCount: 0, acceptedCount: 0, pageCount: 0, fallbackUsed: true };

describe("discoveryOutcomeText", () => {
  it("names the fallback's cause instead of calling every fallback an outage", () => {
    expect(discoveryOutcomeText({ ...base, status: "BUSY" })).toMatch(/busy with other runs/);
    expect(discoveryOutcomeText({ ...base, status: "TIMED_OUT" })).toMatch(/time limit/);
    expect(discoveryOutcomeText({ ...base, status: "BLOCKED" })).toMatch(/not available for this run/);
    expect(discoveryOutcomeText({ ...base, status: "FAILED" })).toMatch(/unavailable/);
  });

  it("reports offered ideas as counts, never a verdict", () => {
    expect(discoveryOutcomeText({ status: "COMPLETED", candidateCount: 5, acceptedCount: 3, pageCount: 4, fallbackUsed: false }))
      .toBe("3 of 5 candidate ideas were offered for review. The candidates referenced 4 pages.");
  });
});

describe("discoveryOutcomeText for a written requirement (Phase B)", () => {
  const base = { status: "FAILED" as const, fallbackUsed: true, acceptedCount: 0, candidateCount: 0, pageCount: 0 };
  it("says the analysis went on without Browser Use, never that survey suggestions were shown", () => {
    expect(discoveryOutcomeText(base, "requirement")).toBe("Browser Use was unavailable. The requirement was analyzed without it.");
    expect(discoveryOutcomeText({ ...base, status: "COMPLETED", fallbackUsed: false, acceptedCount: 2, candidateCount: 5, pageCount: 3 }, "requirement"))
      .toMatch(/^2 of 5 observed routes were used/);
  });
});
