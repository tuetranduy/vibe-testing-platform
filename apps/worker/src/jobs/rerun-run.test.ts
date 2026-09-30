import type { GeneratedTest, NormalizedRequirement } from "@platform/contracts";
import { GeneratedTestRepository, RequirementRepository, ResultRepository, RunRepository, SecretRepository, SuiteRunRepository } from "@platform/db";
import { TEST_TENANT_ID } from "@platform/db/testing";
import { encryptSecret } from "@platform/security";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SECRETS_KEY, createFakeStages, createHarness, eventsOf, request, requestCancel, type WorkerHarness } from "../test-support";
import type { RunLlmFactory } from "../run-llm";
import { rerunRunJob } from "./rerun-run";

let h: WorkerHarness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => h?.close());

const requirement = (runId: string): NormalizedRequirement => ({
  runId,
  revision: 1,
  originalText: "A user can add a product to the cart. The cart count should increase.",
  criteria: [
    {
      id: "AC-1",
      sourceText: "The cart count should increase.",
      statement: "The cart count increases",
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
    { key: "cartCount", checkpoint: "before_add", description: "Cart count", valueType: "number" },
    { key: "cartCount", checkpoint: "after_add", description: "Cart count", valueType: "number" },
  ],
  confirmedAt: "2026-09-29T10:00:00.000Z",
});

/** A queued manual rerun, as the API creates it: copies of the source's requirement and saved test. */
async function queuedRerun(secrets: Record<string, string> = {}, suiteRunId?: string) {
  const runs = new RunRepository(h.tdb.db);
  const run = await runs.create({
    tenantId: TEST_TENANT_ID,
    targetUrl: "https://shop.example.com",
    request: { ...request({}, Object.keys(secrets)), rerunOf: "run_source" },
    ...(suiteRunId ? { suiteRunId } : {}),
  });
  await new SecretRepository(h.tdb.db).insertMany(
    run.id,
    Object.entries(secrets).map(([name, v]) => ({ name, ...encryptSecret(v, { runId: run.id, name }, SECRETS_KEY) })),
  );
  await new RequirementRepository(h.tdb.db).copyConfirmed(run.id, requirement(run.id));
  const test: GeneratedTest = {
    id: `gt_${run.id}`,
    source: "",
    helpersSource: "",
    dataJson: "{}",
    compiledCriteria: ["AC-1"],
    notCompiled: [],
    notes: [],
  };
  await new GeneratedTestRepository(h.tdb.db).save(run.id, test);
  return run;
}

describe("rerun-run (V1.1 F5)", () => {
  it("QUEUED → RUNNING_PLAYWRIGHT → GENERATING_REPORT → COMPLETED with rerun-confirmed results, no model client, secrets purged", async () => {
    const run = await queuedRerun({ password: "pw-123456" });
    const forRun = { called: 0 };
    const runLlm: RunLlmFactory = {
      forRun: async () => {
        forRun.called++;
        throw new Error("a rerun must not build a model client");
      },
      choiceOf: () => ({ provider: "fake", model: "fake", reasoning: "default" }),
    };
    await rerunRunJob(h.deps(createFakeStages(), { runLlm }), run.id);

    const after = await new RunRepository(h.tdb.db).getById(run.id);
    expect(after).toMatchObject({ lifecycle: "COMPLETED", verdict: "PASSED" });
    expect(forRun.called).toBe(0);
    const trail: string[] = [];
    for (const e of await eventsOf(h, run.id)) if (trail.at(-1) !== e.stage) trail.push(e.stage);
    expect(trail).toEqual(["RUNNING_PLAYWRIGHT", "GENERATING_REPORT", "COMPLETED"]);
    expect(await new ResultRepository(h.tdb.db).listByRun(run.id)).toMatchObject([
      { criterionId: "AC-1", status: "PASS", verdictSource: "PLAYWRIGHT_RERUN", rerunOutcome: "PASSED" },
    ]);
    expect(await new SecretRepository(h.tdb.db).listActive(run.id)).toEqual([]);
  });

  it("skips anything that is not a queued rerun", async () => {
    const runs = new RunRepository(h.tdb.db);
    const plain = await runs.create({ tenantId: TEST_TENANT_ID, targetUrl: "https://shop.example.com", request: request() });
    await rerunRunJob(h.deps(createFakeStages()), plain.id);
    expect((await runs.getById(plain.id)).lifecycle).toBe("QUEUED");
    await rerunRunJob(h.deps(createFakeStages()), "run_missing");
  });

  it("settles its suite run when it is the last child to end (V1.2 F1)", async () => {
    const suiteRuns = new SuiteRunRepository(h.tdb.db);
    const suiteRun = await suiteRuns.create({ tenantId: TEST_TENANT_ID, suiteId: "ste_x", suiteName: "Smoke", trigger: "manual", ownerUserId: null });
    const [first, second] = [await queuedRerun({}, suiteRun.id), await queuedRerun({}, suiteRun.id)];
    await rerunRunJob(h.deps(createFakeStages()), first.id);
    expect(await suiteRuns.findById(suiteRun.id)).toMatchObject({ status: "RUNNING", verdict: null });
    await rerunRunJob(h.deps(createFakeStages()), second.id);
    expect(await suiteRuns.findById(suiteRun.id)).toMatchObject({ status: "COMPLETED", verdict: "PASSED" });
  });

  it("a cancel request before the rerun ends the run CANCELLED", async () => {
    const run = await queuedRerun();
    await requestCancel(h, run.id);
    await rerunRunJob(h.deps(createFakeStages()), run.id);
    expect(await new RunRepository(h.tdb.db).getById(run.id)).toMatchObject({ lifecycle: "CANCELLED", cancelReason: "USER_REQUESTED" });
  });
});
