import { describe, expect, it } from "vitest";
import { findingStatus, reproductionRequirement } from "./findings";
import { CreateTestRunRequestSchema } from "./run";
import { DiscoveryResultSchema } from "./discovery";
import { NormalizedRequirementSchema } from "./requirement";

const open = { dismissedAt: null, reproductionRunId: "run_2" };

describe("exploratory findings (Phase C)", () => {
  it("only an independent reproduction's verdict, or a reviewer, changes a hypothesis", () => {
    expect(findingStatus({ dismissedAt: null, reproductionRunId: null }, null)).toEqual({ status: "HYPOTHESIS", statusReason: "not_reviewed" });
    expect(findingStatus(open, { lifecycle: "EXPLORING", verdict: null })).toEqual({ status: "HYPOTHESIS", statusReason: "reproduction_running" });
    expect(findingStatus(open, { lifecycle: "COMPLETED", verdict: "FAILED" })).toEqual({ status: "REPRODUCED", statusReason: "reproduced" });
    expect(findingStatus(open, { lifecycle: "COMPLETED", verdict: "PASSED" })).toEqual({ status: "DISMISSED", statusReason: "not_reproduced" });
    expect(findingStatus(open, { lifecycle: "COMPLETED", verdict: "BLOCKED" }).status).toBe("BLOCKED");
    expect(findingStatus(open, { lifecycle: "COMPLETED", verdict: "INCONCLUSIVE" }).status).toBe("INCONCLUSIVE");
    expect(findingStatus(open, { lifecycle: "ERRORED", verdict: null }).status).toBe("INCONCLUSIVE");
    expect(findingStatus({ ...open, dismissedAt: "2026-11-24T00:00:00.000Z" }, { lifecycle: "COMPLETED", verdict: "FAILED" }).status).toBe("DISMISSED");
    // A deleted reproduction run leaves the finding a hypothesis.
    expect(findingStatus(open, null).status).toBe("HYPOTHESIS");
  });

  it("builds the reproduction requirement from the steps and the expected behavior, never the agent's observation", () => {
    const text = reproductionRequirement({ path: "/help", reproduction: ["Open the home page", "Click Help"], expected: "the help page opens." });
    expect(text).toBe("Starting on /help:\n1. Open the home page\n2. Click Help\nVerify that the help page opens.");
    expect(CreateTestRunRequestSchema.safeParse({ targetUrl: "https://shop.example.com/help", requirement: text }).success).toBe(true);
  });

  it("findings ride only on a completed result", () => {
    const finding = { title: "Broken help", observation: "The Help link shows Not Found.", expected: "Help opens", path: "/help", reproduction: ["Click Help"], severity: "low" };
    const candidate = { title: "Open help", goal: "Open the help page.", rationale: "Linked", relevantPaths: ["/help"], expectedBehavior: ["Help opens"], negativeCases: [] };
    expect(DiscoveryResultSchema.safeParse({ schemaVersion: "discovery.v1", runId: "r1", status: "COMPLETED", candidates: [candidate], findings: [finding] }).success).toBe(true);
    expect(DiscoveryResultSchema.safeParse({ schemaVersion: "discovery.v1", runId: "r1", status: "PARTIAL", candidates: [], findings: [finding] }).success).toBe(false);
    expect(DiscoveryResultSchema.safeParse({ schemaVersion: "discovery.v1", runId: "r1", status: "COMPLETED", candidates: [candidate],
      findings: [{ ...finding, path: "https://evil.example/" }] }).success).toBe(false);
  });
});

describe("requirement-enriched discovery (Phase B)", () => {
  it("lets a written requirement opt in, but never with automatic confirmation", () => {
    const base = { targetUrl: "http://127.0.0.1:4599/", requirement: "Add a product to the cart.", environment: "staging" };
    expect(CreateTestRunRequestSchema.safeParse({ ...base, options: { autonomousDiscovery: true } }).success).toBe(true);
    expect(CreateTestRunRequestSchema.safeParse({ ...base, options: { autonomousDiscovery: true, autoConfirmCriteria: true } }).success).toBe(false);
    expect(CreateTestRunRequestSchema.safeParse({ ...base, environment: "production", options: { autonomousDiscovery: true } }).success).toBe(false);
  });

  it("marks only an inferred criterion as coming from discovery", () => {
    const criterion = {
      id: "AC-1", sourceText: "Add a product", statement: "The cart lists it", critical: true, ambiguity: null, preconditions: [],
      expectedOutcome: { kind: "semantic", description: "The cart lists it" },
    };
    const req = (c: object) => ({ runId: "r", revision: 1, originalText: "Add a product", criteria: [c], facts: [], confirmedAt: null });
    const discovery = { engine: "browser_use", relevantPaths: ["/cart"] };
    expect(NormalizedRequirementSchema.safeParse(req({ ...criterion, discovery })).success).toBe(false);
    expect(NormalizedRequirementSchema.safeParse(req({ ...criterion, discovery, origin: "inferred", rationale: "Browser Use saw it" })).success).toBe(true);
  });
});
