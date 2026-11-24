import { RequirementRepository } from "@platform/db";
import { FakeTransport, LlmClient } from "@platform/llm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunLlmFactory } from "../run-llm";
import { createFakeStages, createHarness, seedRun, type WorkerHarness } from "../test-support";
import { reviseCriterionJob } from "./revise-criterion";

let h: WorkerHarness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => h?.close());

const euros = {
  criteria: [
    {
      sourceText: "x",
      statement: "The price is shown in euros",
      expectedOutcome: { kind: "semantic", description: "The price is shown in euros" },
      preconditions: [],
      ambiguity: null,
    },
  ],
  facts: [],
};

/** Every run on a real-model client over `transport`. */
const withModel = (transport: FakeTransport): RunLlmFactory => {
  const choice = { provider: "deepseek" as const, model: "deepseek-flash", reasoning: "default" as const };
  return { choiceOf: () => choice, discoveryModelFor: async () => null, forRun: async () => ({ choice, llm: new LlmClient({ transport, model: "deepseek-flash", sleep: async () => {} }) }) };
};

describe("reviseCriterionJob (2026-11-19)", () => {
  it("rewrites the criterion of a run awaiting confirmation: the next revision's criteria and facts", async () => {
    const run = await seedRun(h, { lifecycle: "AWAITING_CONFIRMATION" });
    const latest = (await new RequirementRepository(h.tdb.db).findLatest(run.id))!;
    const target = latest.criteria[0]!;
    const transport = new FakeTransport().enqueue({ json: euros });
    const deps = h.deps(createFakeStages(), { runLlm: withModel(transport) });
    const out = await reviseCriterionJob(deps, { runId: run.id, criterionId: target.id, instruction: "the price is shown in euros", basedOnRevision: latest.revision });
    expect(out).toMatchObject({ runId: run.id, criterionId: target.id, basedOnRevision: latest.revision });
    expect(out.criteria.find((c) => c.id === target.id)).toMatchObject({ statement: "The price is shown in euros", sourceText: target.sourceText });
    expect(out.criteria.map((c) => c.id)).toEqual(latest.criteria.map((c) => c.id));
    expect(String(transport.requests[0]!.messages[0]!.content)).toContain("the price is shown in euros");
  });

  it("refuses, with a code the API maps: another lifecycle, a moved-on revision, an unknown criterion, the fake engine", async () => {
    const queued = await seedRun(h, { lifecycle: "QUEUED" });
    const run = await seedRun(h, { lifecycle: "AWAITING_CONFIRMATION" });
    const latest = (await new RequirementRepository(h.tdb.db).findLatest(run.id))!;
    const deps = h.deps(createFakeStages(), { runLlm: withModel(new FakeTransport()) });
    const job = (over: Partial<Parameters<typeof reviseCriterionJob>[1]>) =>
      reviseCriterionJob(deps, { runId: run.id, criterionId: latest.criteria[0]!.id, instruction: "in euros", basedOnRevision: latest.revision, ...over });
    await expect(job({ runId: queued.id })).rejects.toThrow(/^NOT_AWAITING_CONFIRMATION:/);
    await expect(job({ basedOnRevision: latest.revision + 1 })).rejects.toThrow(/^PROPOSAL_STALE:/);
    await expect(job({ criterionId: "AC-99" })).rejects.toThrow(/^UNKNOWN_CRITERION:/);
    await expect(reviseCriterionJob(h.deps(createFakeStages()), { runId: run.id, criterionId: latest.criteria[0]!.id, instruction: "in euros", basedOnRevision: latest.revision })).rejects.toThrow(/^REVISE_NEEDS_MODEL:/);
  });

  it("a model that does not answer in time: REVISE_TIMEOUT (review finding)", async () => {
    const run = await seedRun(h, { lifecycle: "AWAITING_CONFIRMATION" });
    const latest = (await new RequirementRepository(h.tdb.db).findLatest(run.id))!;
    const deps = h.deps(createFakeStages(), { runLlm: withModel(new FakeTransport().enqueue("hang")) });
    await expect(
      reviseCriterionJob(deps, { runId: run.id, criterionId: latest.criteria[0]!.id, instruction: "in euros", basedOnRevision: latest.revision }, { timeoutMs: 50 }),
    ).rejects.toThrow(/^REVISE_TIMEOUT:/);
  });

  it("a model answer still invalid after the correction: REVISE_INVALID", async () => {
    const run = await seedRun(h, { lifecycle: "AWAITING_CONFIRMATION" });
    const latest = (await new RequirementRepository(h.tdb.db).findLatest(run.id))!;
    const two = { ...euros, criteria: [euros.criteria[0], euros.criteria[0]] };
    const deps = h.deps(createFakeStages(), { runLlm: withModel(new FakeTransport().enqueue({ json: two }, { json: two })) });
    await expect(reviseCriterionJob(deps, { runId: run.id, criterionId: latest.criteria[0]!.id, instruction: "in euros", basedOnRevision: latest.revision })).rejects.toThrow(/^REVISE_INVALID:/);
  });
});
