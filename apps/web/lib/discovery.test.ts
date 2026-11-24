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
      .toBe("3 of 5 candidate ideas were offered for review. The candidates referenced 4 fixture pages.");
  });
});
