import type { NormalizedRequirement } from "@platform/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RequirementFrozenError, RequirementStateError } from "./errors";
import { RequirementRepository } from "./requirement-repository";
import { RunRepository } from "./run-repository";
import { storedRequest } from "./test-helpers";
import { TEST_TENANT_ID, createTestDatabase, type TestDatabase } from "./testing";

let tdb: TestDatabase;
let runs: RunRepository;
let reqs: RequirementRepository;
beforeAll(async () => {
  tdb = await createTestDatabase();
  runs = new RunRepository(tdb.db);
  reqs = new RequirementRepository(tdb.db);
});
afterAll(async () => tdb?.drop());

const TEXT = "A user can add a product to the cart. The cart count should increase.";
const requirement = (statement = "Cart count increases"): Omit<NormalizedRequirement, "runId" | "revision" | "confirmedAt"> => ({
  originalText: TEXT,
  criteria: [
    {
      id: "AC-1",
      sourceText: "The cart count should increase.",
      statement,
      expectedOutcome: {
        kind: "numeric_compare",
        left: { key: "cartCount", checkpoint: "after_add" },
        operator: "gt",
        right: { key: "cartCount", checkpoint: "before_add" },
      },
      preconditions: [],
      critical: true,
      ambiguity: null,
    },
  ],
  facts: [
    { key: "cartCount", checkpoint: "before_add", description: "Cart badge count", valueType: "number" },
    { key: "cartCount", checkpoint: "after_add", description: "Cart badge count", valueType: "number" },
  ],
});

async function runIn(lifecycle: "ANALYZING_REQUIREMENT" | "AWAITING_CONFIRMATION" | "QUEUED") {
  const run = await runs.create({ tenantId: TEST_TENANT_ID, targetUrl: "https://x.com", request: storedRequest() });
  if (lifecycle === "QUEUED") return run;
  await runs.transition(run.id, "QUEUED", "ANALYZING_REQUIREMENT");
  if (lifecycle === "AWAITING_CONFIRMATION") await runs.transition(run.id, "ANALYZING_REQUIREMENT", "AWAITING_CONFIRMATION");
  return run;
}

describe("RequirementRepository", () => {
  it("creates numbered revisions and returns the latest", async () => {
    const run = await runIn("ANALYZING_REQUIREMENT");
    const r1 = await reqs.createRevision(run.id, requirement());
    expect(r1.revision).toBe(1);
    expect(r1.confirmedAt).toBeNull();
    await runs.transition(run.id, "ANALYZING_REQUIREMENT", "AWAITING_CONFIRMATION");
    const r2 = await reqs.createRevision(run.id, requirement("Edited statement"));
    expect(r2.revision).toBe(2);
    expect((await reqs.getLatest(run.id)).criteria[0]!.statement).toBe("Edited statement");
  });

  it("freezes criteria at confirmation", async () => {
    const run = await runIn("AWAITING_CONFIRMATION");
    await reqs.createRevision(run.id, requirement());
    const confirmed = await reqs.confirm(run.id, 1);
    expect(confirmed.confirmedAt).not.toBeNull();
    await expect(reqs.createRevision(run.id, requirement("x y z"))).rejects.toBeInstanceOf(RequirementFrozenError);
    await expect(reqs.confirm(run.id, 1)).rejects.toBeInstanceOf(RequirementFrozenError);
  });

  it("rejects confirming a stale revision", async () => {
    const run = await runIn("AWAITING_CONFIRMATION");
    await reqs.createRevision(run.id, requirement());
    await reqs.createRevision(run.id, requirement("second"));
    await expect(reqs.confirm(run.id, 1)).rejects.toBeInstanceOf(RequirementStateError);
  });

  it("rejects revisions outside ANALYZING_REQUIREMENT / AWAITING_CONFIRMATION", async () => {
    const run = await runIn("QUEUED");
    await expect(reqs.createRevision(run.id, requirement())).rejects.toBeInstanceOf(RequirementStateError);
  });

  it("rejects changing originalText", async () => {
    const run = await runIn("AWAITING_CONFIRMATION");
    await reqs.createRevision(run.id, requirement());
    await expect(
      reqs.createRevision(run.id, { ...requirement(), originalText: `${TEXT} More.` }),
    ).rejects.toBeInstanceOf(RequirementStateError);
  });

  it("validates cross-references on write", async () => {
    const run = await runIn("AWAITING_CONFIRMATION");
    const bad = requirement();
    bad.facts = [];
    await expect(reqs.createRevision(run.id, bad)).rejects.toThrow(/not declared/);
  });
});
