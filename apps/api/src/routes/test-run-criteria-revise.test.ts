import type { NormalizedRequirement } from "@platform/contracts";
import { EventRepository, RequirementRepository, RunRepository } from "@platform/db";
import { RevisionFailedError, RevisionTimeoutError, type CriterionProposal, type ReviseJobData, type RevisionQueue } from "@platform/event-bus";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auth, createTestApi, validBody, type TestApi } from "../test-support";

/** Answers each rewrite with `answer` (or throws it); keeps every proposal it handed out. */
class FakeRevisions implements RevisionQueue {
  readonly asked: ReviseJobData[] = [];
  readonly made = new Map<string, CriterionProposal>();
  answer: ((data: ReviseJobData) => Omit<CriterionProposal, "proposalId">) | Error = new Error("unset");
  async request(data: ReviseJobData) {
    this.asked.push(data);
    if (this.answer instanceof Error) throw this.answer;
    const proposal = { ...this.answer(data), proposalId: `revise-criterion__${data.runId}__${this.made.size + 1}` };
    this.made.set(proposal.proposalId, proposal);
    return proposal;
  }
  async proposal(id: string) {
    return this.made.get(id) ?? null;
  }
  async close() {}
}

const revisions = new FakeRevisions();
let t: TestApi;
beforeAll(async () => {
  t = await createTestApi({}, { revisions });
});
afterAll(async () => t?.close());
beforeEach(() => {
  revisions.asked.length = 0;
});

const TEXT = "A user can add a product to the cart. The cart count should increase.";
type Draft = Omit<NormalizedRequirement, "runId" | "revision" | "confirmedAt">;
const draft = (): Draft => ({
  originalText: TEXT,
  criteria: [
    {
      id: "AC-1",
      sourceText: "The cart count should increase.",
      statement: "Cart count increases",
      expectedOutcome: { kind: "semantic", description: "The cart count increases" },
      preconditions: [],
      critical: true,
      ambiguity: null,
    },
  ],
  facts: [],
});
/** What the worker proposes for AC-1: a deterministic count check. */
const counted = (data: ReviseJobData): Omit<CriterionProposal, "proposalId"> => ({
  runId: data.runId,
  criterionId: data.criterionId,
  basedOnRevision: data.basedOnRevision,
  criteria: [
    {
      ...draft().criteria[0]!,
      statement: "The cart count goes up by 1",
      expectedOutcome: { kind: "numeric_delta", before: { key: "cartCount", checkpoint: "before_add" }, after: { key: "cartCount", checkpoint: "after_add" }, delta: 1 },
    },
  ],
  facts: [
    { key: "cartCount", checkpoint: "before_add", description: "Cart badge count", valueType: "number" },
    { key: "cartCount", checkpoint: "after_add", description: "Cart badge count", valueType: "number" },
  ],
});

async function awaiting(): Promise<string> {
  const { runId } = (await t.app.inject({ method: "POST", url: "/v1/test-runs", headers: auth, payload: validBody({ requirement: TEXT }) })).json();
  const runs = new RunRepository(t.tdb.db);
  await runs.transition(runId, "QUEUED", "ANALYZING_REQUIREMENT");
  await runs.transition(runId, "ANALYZING_REQUIREMENT", "AWAITING_CONFIRMATION");
  await new RequirementRepository(t.tdb.db).createRevision(runId, draft());
  return runId;
}
const revise = (runId: string, criterionId: string, payload: unknown) =>
  t.app.inject({ method: "POST", url: `/v1/test-runs/${runId}/criteria/${criterionId}/revise`, headers: auth, payload: payload as object });
const accept = (runId: string, proposalId: string) =>
  t.app.inject({ method: "POST", url: `/v1/test-runs/${runId}/criteria/proposals/${encodeURIComponent(proposalId)}/accept`, headers: auth });

describe("POST /v1/test-runs/:runId/criteria/:criterionId/revise (2026-11-19)", () => {
  it("asks the worker with the latest revision and answers its proposal; nothing is saved yet", async () => {
    revisions.answer = counted;
    const runId = await awaiting();
    const res = await revise(runId, "AC-1", { instruction: "  the count goes up by 1  " });
    expect(res.statusCode).toBe(200);
    expect(revisions.asked).toEqual([{ runId, criterionId: "AC-1", instruction: "the count goes up by 1", basedOnRevision: 1 }]);
    expect(res.json()).toMatchObject({ criterionId: "AC-1", basedOnRevision: 1, criteria: [{ statement: "The cart count goes up by 1" }] });
    expect((await new RequirementRepository(t.tdb.db).findLatest(runId))!.revision).toBe(1);
  });

  it("refuses a short or long instruction (400), an unknown criterion (404), a run not awaiting confirmation (409)", async () => {
    revisions.answer = counted;
    const runId = await awaiting();
    expect((await revise(runId, "AC-1", { instruction: "ab" })).statusCode).toBe(400);
    expect((await revise(runId, "AC-1", { instruction: "x".repeat(501) })).statusCode).toBe(400);
    expect((await revise(runId, "AC-9", { instruction: "the count goes up" })).statusCode).toBe(404);
    await new RunRepository(t.tdb.db).transition(runId, "AWAITING_CONFIRMATION", "CANCELLED", { cancelReason: "USER_REQUESTED" });
    expect((await revise(runId, "AC-1", { instruction: "the count goes up" })).json().code).toBe("CONFLICT");
    expect(revisions.asked).toEqual([]);
  });

  it("maps the worker's answers: no model 422, stale 409, timeout 504, other failures 502", async () => {
    const runId = await awaiting();
    const code = async (answer: Error) => {
      revisions.answer = answer;
      const res = await revise(runId, "AC-1", { instruction: "the count goes up" });
      return [res.statusCode, res.json().code];
    };
    expect(await code(new RevisionFailedError("REVISE_NEEDS_MODEL", "no model"))).toEqual([422, "REVISE_NEEDS_MODEL"]);
    expect(await code(new RevisionFailedError("PROPOSAL_STALE", "moved on"))).toEqual([409, "PROPOSAL_STALE"]);
    expect(await code(new RevisionFailedError("REVISE_INVALID", "bad"))).toEqual([422, "REVISE_INVALID"]);
    expect(await code(new RevisionTimeoutError("slow"))).toEqual([504, "REVISE_TIMEOUT"]);
    expect(await code(new RevisionFailedError("REVISE_TIMEOUT", "the model took too long"))).toEqual([504, "REVISE_TIMEOUT"]);
    expect(await code(new RevisionFailedError("REVISE_FAILED", "provider down"))).toEqual([502, "REVISE_FAILED"]);
  });
});

describe("POST /v1/test-runs/:runId/criteria/proposals/:proposalId/accept (2026-11-19)", () => {
  it("saves the proposal as the next revision and publishes criteria.updated", async () => {
    revisions.answer = counted;
    const runId = await awaiting();
    const { proposalId } = (await revise(runId, "AC-1", { instruction: "the count goes up by 1" })).json();
    const res = await accept(runId, proposalId);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ revision: 2, criteria: [{ id: "AC-1", statement: "The cart count goes up by 1" }], facts: [{ key: "cartCount" }, { key: "cartCount" }] });
    const events = await new EventRepository(t.tdb.db).listAfter(runId, 0);
    expect(events.map((e) => e.type)).toContain("criteria.updated");
  });

  it("two proposals accepted at once: one is saved, the other is 409 PROPOSAL_STALE (review finding)", async () => {
    revisions.answer = counted;
    const runId = await awaiting();
    const a = (await revise(runId, "AC-1", { instruction: "the count goes up by 1" })).json();
    const b = (await revise(runId, "AC-1", { instruction: "the count goes up by one" })).json();
    const [x, y] = await Promise.all([accept(runId, a.proposalId), accept(runId, b.proposalId)]);
    expect([x.statusCode, y.statusCode].sort()).toEqual([200, 409]);
    expect([x, y].find((r) => r.statusCode === 409)!.json().code).toBe("PROPOSAL_STALE");
    expect((await new RequirementRepository(t.tdb.db).findLatest(runId))!.revision).toBe(2);
  });

  it("a proposal for an older revision is 409 PROPOSAL_STALE; another run's or an unknown one is 404; nothing saved", async () => {
    revisions.answer = counted;
    const runId = await awaiting();
    const first = (await revise(runId, "AC-1", { instruction: "the count goes up by 1" })).json();
    const second = (await revise(runId, "AC-1", { instruction: "the count goes up by one" })).json();
    expect((await accept(runId, first.proposalId)).statusCode).toBe(200);
    const stale = await accept(runId, second.proposalId);
    expect([stale.statusCode, stale.json().code]).toEqual([409, "PROPOSAL_STALE"]);
    const other = await awaiting();
    expect((await accept(other, first.proposalId)).statusCode).toBe(404);
    expect((await accept(other, "revise-criterion__nope__1")).statusCode).toBe(404);
    expect((await new RequirementRepository(t.tdb.db).findLatest(other))!.revision).toBe(1);
  });
});

describe("without a revisions queue", () => {
  it("is 503 REVISE_UNAVAILABLE", async () => {
    const bare = await createTestApi();
    try {
      const { runId } = (await bare.app.inject({ method: "POST", url: "/v1/test-runs", headers: auth, payload: validBody({ requirement: TEXT }) })).json();
      const runs = new RunRepository(bare.tdb.db);
      await runs.transition(runId, "QUEUED", "ANALYZING_REQUIREMENT");
      await runs.transition(runId, "ANALYZING_REQUIREMENT", "AWAITING_CONFIRMATION");
      await new RequirementRepository(bare.tdb.db).createRevision(runId, draft());
      const res = await bare.app.inject({ method: "POST", url: `/v1/test-runs/${runId}/criteria/AC-1/revise`, headers: auth, payload: { instruction: "the count goes up" } });
      expect([res.statusCode, res.json().code]).toEqual([503, "REVISE_UNAVAILABLE"]);
    } finally {
      await bare.close();
    }
  });
});
