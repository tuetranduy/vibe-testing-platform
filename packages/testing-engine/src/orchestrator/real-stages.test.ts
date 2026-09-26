import type { NormalizedRequirement, TestPlan } from "@platform/contracts";
import { describe, expect, it } from "vitest";
import { createFakeStages } from "./fake-stages";
import { createRealStages } from "./real-stages";
import type { StageContext } from "./stages";

const requirement = {
  criteria: [{ id: "AC-1" }, { id: "AC-2" }, { id: "AC-3" }].map((c) => ({ ...c, statement: `stmt ${c.id}` })),
} as unknown as NormalizedRequirement;
const plan = {
  blockedCriteria: [{ criterionId: "AC-3", reason: "MISSING_SECRET", detail: "no password" }],
} as unknown as TestPlan;
const exploration = { steps: [], facts: [], stopReason: "COMPLETED" as const };
const llm = { generateStructured: async () => ({}) as never };
const explorationDeps = { openSandbox: async () => ({}) as never, explorer: { start: async () => ({}) as never }, store: () => ({}) as never };

describe("createRealStages", () => {
  it.each(["PASS", "FAIL"] as const)("downgrades a fake %s to INCONCLUSIVE/FACT_NOT_OBSERVED; BLOCKED stays", (status) => {
    const stages = createRealStages({ llm, exploration: explorationDeps }, createFakeStages({ provisionalStatus: status }));
    const results = stages.verify({} as StageContext, requirement, plan, exploration);
    expect(results.map((r) => [r.criterionId, r.status, r.reason])).toEqual([
      ["AC-1", "INCONCLUSIVE", "FACT_NOT_OBSERVED"],
      ["AC-2", "INCONCLUSIVE", "FACT_NOT_OBSERVED"],
      ["AC-3", "BLOCKED", "MISSING_SECRET"],
    ]);
    expect(results.every((r) => r.actual === null)).toBe(true);
  });
});
