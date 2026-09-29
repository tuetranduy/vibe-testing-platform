import type { NormalizedRequirement } from "@platform/contracts";
import { EventRepository, RequirementRepository, RunRepository } from "@platform/db";
import { OTHER_TENANT_ID } from "@platform/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auth, createTestApi, validBody, type TestApi } from "../test-support";

let t: TestApi;
beforeAll(async () => {
  t = await createTestApi();
});
afterAll(async () => t?.close());
beforeEach(() => {
  t.queue.fail = false;
});

const ORIGINAL_TEXT =
  "A user can add a product to the cart. The cart count should increase. A confirmation message should appear.";

type Draft = Omit<NormalizedRequirement, "runId" | "revision" | "confirmedAt">;

/** Two criteria: a deterministic numeric compare and a deterministic text match. */
function baseRequirement(): Draft {
  return {
    originalText: ORIGINAL_TEXT,
    criteria: [
      {
        id: "AC-1",
        sourceText: "The cart count should increase.",
        statement: "Cart count increases",
        expectedOutcome: {
          kind: "numeric_compare",
          left: { key: "cartCount", checkpoint: "after_add" },
          operator: "gt",
          right: { key: "cartCount", checkpoint: "before_add" },
        },
        preconditions: [],
        ambiguity: null,
      },
      {
        id: "AC-2",
        sourceText: "A confirmation message should appear.",
        statement: "A confirmation message appears",
        expectedOutcome: {
          kind: "text_matches",
          fact: { key: "confirmationMessage", checkpoint: "after_add" },
          match: { mode: "contains", value: "cart", caseSensitive: false },
        },
        preconditions: [],
        ambiguity: null,
      },
    ],
    facts: [
      { key: "cartCount", checkpoint: "before_add", description: "Cart badge count", valueType: "number" },
      { key: "cartCount", checkpoint: "after_add", description: "Cart badge count", valueType: "number" },
      { key: "confirmationMessage", checkpoint: "after_add", description: "Confirmation text", valueType: "string" },
    ],
  };
}

/** One clean, one ambiguous, one semantic criterion (for the warnings test). */
function requirementWithWarnings(): Draft {
  return {
    originalText: ORIGINAL_TEXT,
    criteria: [
      {
        id: "AC-1",
        sourceText: "The cart count should increase.",
        statement: "Cart count increases",
        expectedOutcome: {
          kind: "numeric_compare",
          left: { key: "cartCount", checkpoint: "after_add" },
          operator: "gt",
          right: { key: "cartCount", checkpoint: "before_add" },
        },
        preconditions: [],
        ambiguity: { reason: "Amount not specified", suggestions: ["Increase by exactly 1"] },
      },
      {
        id: "AC-2",
        sourceText: "A confirmation message should appear.",
        statement: "The page looks correct after adding to cart",
        expectedOutcome: { kind: "semantic", description: "The page should look correct after adding to cart" },
        preconditions: [],
        ambiguity: null,
      },
      {
        id: "AC-3",
        sourceText: "A user can add a product to the cart.",
        statement: "Adding a product succeeds",
        expectedOutcome: {
          kind: "numeric_compare",
          left: { key: "cartCount", checkpoint: "after_add" },
          operator: "gt",
          right: { key: "cartCount", checkpoint: "before_add" },
        },
        preconditions: [],
        ambiguity: null,
      },
    ],
    facts: [
      { key: "cartCount", checkpoint: "before_add", description: "Cart badge count", valueType: "number" },
      { key: "cartCount", checkpoint: "after_add", description: "Cart badge count", valueType: "number" },
    ],
  };
}

async function setupAwaitingConfirmation(draft: Draft = baseRequirement(), extra: Record<string, unknown> = {}): Promise<string> {
  const { runId } = (await post(validBody({ requirement: ORIGINAL_TEXT, ...extra }))).json();
  const runs = new RunRepository(t.tdb.db);
  await runs.transition(runId, "QUEUED", "ANALYZING_REQUIREMENT");
  await runs.transition(runId, "ANALYZING_REQUIREMENT", "AWAITING_CONFIRMATION");
  await new RequirementRepository(t.tdb.db).createRevision(runId, draft);
  return runId;
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  t.app.inject({ method: "POST", url: "/v1/test-runs", headers: { ...auth, ...headers }, payload: body as object });

const getCriteria = (runId: string) => t.app.inject({ method: "GET", url: `/v1/test-runs/${runId}/criteria`, headers: auth });

const putCriteria = (runId: string, body: unknown) =>
  t.app.inject({ method: "PUT", url: `/v1/test-runs/${runId}/criteria`, headers: auth, payload: body as object });

const confirmCriteria = (runId: string) =>
  t.app.inject({ method: "POST", url: `/v1/test-runs/${runId}/criteria/confirm`, headers: auth });

describe("GET /v1/test-runs/:runId/criteria", () => {
  it("returns 409 CRITERIA_NOT_READY before analysis finishes", async () => {
    const { runId } = (await post(validBody())).json();
    const res = await getCriteria(runId);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("CRITERIA_NOT_READY");
  });

  it("returns the latest revision", async () => {
    const runId = await setupAwaitingConfirmation();
    const res = await getCriteria(runId);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.revision).toBe(1);
    expect(body.originalText).toBe(ORIGINAL_TEXT);
    expect(body.criteria).toHaveLength(2);
    expect(body.confirmedAt).toBeNull();
  });

  it("returns 404 for another tenant's run", async () => {
    const other = await new RunRepository(t.tdb.db).create({
      tenantId: OTHER_TENANT_ID,
      targetUrl: "https://x.com",
      request: { ...validBody(), environment: "staging", browser: "chromium", testData: {}, secretNames: [], options: {} as never },
    });
    expect((await getCriteria(other.id)).statusCode).toBe(404);
  });
});

describe("PUT /v1/test-runs/:runId/criteria", () => {
  it("saves an edited requirement as revision n+1 and publishes criteria.updated", async () => {
    const runId = await setupAwaitingConfirmation();
    const current = getCriteriaBody(await getCriteria(runId));
    const second = current.criteria[1]!;
    const edited = {
      ...current,
      criteria: [
        {
          ...second,
          statement: "A confirmation banner appears",
          expectedOutcome: { ...second.expectedOutcome, match: { mode: "contains", value: "added", caseSensitive: false } },
        },
      ],
      facts: current.facts.filter((f: { key: string }) => f.key === "confirmationMessage"),
    };
    const res = await putCriteria(runId, edited);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.revision).toBe(2);
    expect(body.criteria).toHaveLength(1);
    // The check changed, so the server wrote the wording from it (the client's text is ignored).
    expect(body.criteria[0].statement).toBe("Confirmation text (at “after add”) contains “added” (ignoring case).");
    expect(body.criteria[0].expectedOutcome.match.value).toBe("added");

    const events = await new EventRepository(t.tdb.db).listAfter(runId, 0);
    const updated = events.find((e) => e.type === "criteria.updated");
    expect(updated).toBeDefined();
    expect(updated!.payload).toEqual({ revision: 2 });
    expect(updated!.message).toBe("Criteria revision 2 saved");
  });

  it("refuses a check value that is one of the run's secret values (found by fingerprint), and stores nothing", async () => {
    const runId = await setupAwaitingConfirmation(baseRequirement(), { secrets: { password: "hunter2-long-pw" } });
    const current = getCriteriaBody(await getCriteria(runId));
    const res = await putCriteria(runId, {
      ...current,
      criteria: current.criteria.map((c: NormalizedRequirement["criteria"][number], i: number) =>
        i === 1 ? { ...c, expectedOutcome: { ...c.expectedOutcome, match: { mode: "contains", value: "pw hunter2-long-pw", caseSensitive: false } } } : c,
      ),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      code: "VALIDATION_FAILED",
      issues: [{ path: ["criteria", 1, "expectedOutcome", "match", "value"] }],
    });
    expect((await new RequirementRepository(t.tdb.db).getLatest(runId)).revision).toBe(1);
    expect(res.body).not.toContain("hunter2-long-pw");
  });

  /** "The cart holds 1 item": a numeric check against a literal. */
  function oneItemRequirement(): Draft {
    const base = baseRequirement();
    return {
      ...base,
      criteria: [
        {
          id: "AC-1",
          sourceText: "The cart count should increase.",
          statement: "The cart holds 1 item",
          expectedOutcome: { kind: "numeric_compare", left: { key: "cartCount", checkpoint: "after_add" }, operator: "eq", right: 1 },
          preconditions: [],
          ambiguity: null,
        },
      ],
      facts: base.facts.filter((f) => f.key === "cartCount"),
    };
  }

  /** The latest revision with criterion `index`'s check replaced by `patch` applied to it. */
  function withCheck(current: NormalizedRequirement, index: number, patch: Record<string, unknown>) {
    return {
      ...current,
      criteria: current.criteria.map((c, i) => (i === index ? { ...c, expectedOutcome: { ...c.expectedOutcome, ...patch } } : c)),
    };
  }

  it("regression: rewording '1 item' to '2 items' is refused; changing the check to 2 saves a check and wording that both say 2", async () => {
    const runId = await setupAwaitingConfirmation(oneItemRequirement());
    const current = getCriteriaBody(await getCriteria(runId));

    const reworded = await putCriteria(runId, { ...current, criteria: [{ ...current.criteria[0]!, statement: "The cart holds 2 items" }] });
    expect(reworded.statusCode).toBe(400);
    expect(reworded.json()).toMatchObject({ code: "STATEMENT_ONLY_EDIT", issues: [{ path: ["criteria", 0, "statement"] }] });
    expect(getCriteriaBody(await getCriteria(runId)).revision).toBe(1); // nothing saved

    const edited = await putCriteria(runId, withCheck(current, 0, { right: 2 }));
    expect(edited.statusCode).toBe(200);
    const saved = edited.json();
    expect(saved.revision).toBe(2);
    expect(saved.criteria[0].expectedOutcome.right).toBe(2);
    expect(saved.criteria[0].statement).toBe("Cart badge count (at “after add”) equals 2.");
  });

  it("clears ambiguity on an edited criterion and keeps it on an unedited one", async () => {
    const runId = await setupAwaitingConfirmation(requirementWithWarnings());
    const current = getCriteriaBody(await getCriteria(runId));
    const res = await putCriteria(runId, withCheck(current, 0, { operator: "gte" }));
    expect(res.statusCode).toBe(200);
    const saved = res.json();
    expect(saved.criteria[0].ambiguity).toBeNull();
    expect(saved.criteria[0].statement).toBe("Cart badge count (at “after add”) is at least Cart badge count (at “before add”).");
    expect(saved.criteria[1]).toEqual(current.criteria[1]);
  });

  it("rejects changing what a check reads with 400 VALIDATION_FAILED and an issue path", async () => {
    const runId = await setupAwaitingConfirmation();
    const current = getCriteriaBody(await getCriteria(runId));
    const res = await putCriteria(runId, withCheck(current, 0, { left: { key: "cartCount", checkpoint: "before_add" } }));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "VALIDATION_FAILED", issues: [{ path: ["criteria", 0, "expectedOutcome"] }] });
  });

  it("rejects a body whose originalText differs from the stored one, with 400", async () => {
    const runId = await setupAwaitingConfirmation();
    const current = getCriteriaBody(await getCriteria(runId));
    const res = await putCriteria(runId, { ...current, originalText: `${ORIGINAL_TEXT} More text.` });
    expect(res.statusCode).toBe(400);
    const paths = res.json().issues.map((i: { path: string[] }) => i.path.join("."));
    expect(paths).toContain("originalText");
  });

  it("returns 400 with Zod issue paths when every criterion is removed", async () => {
    const runId = await setupAwaitingConfirmation();
    const current = getCriteriaBody(await getCriteria(runId));
    const res = await putCriteria(runId, { ...current, criteria: [] });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
    const paths = body.issues.map((i: { path: string[] }) => i.path.join("."));
    expect(paths).toContain("criteria");
  });

  it("returns 409 while the requirement is still being analyzed, and never saves the body", async () => {
    const { runId } = (await post(validBody({ requirement: ORIGINAL_TEXT }))).json();
    const runs = new RunRepository(t.tdb.db);
    await runs.transition(runId, "QUEUED", "ANALYZING_REQUIREMENT");
    const requirements = new RequirementRepository(t.tdb.db);
    await requirements.createRevision(runId, baseRequirement()); // the worker saved revision 1, not yet AWAITING_CONFIRMATION
    const current = getCriteriaBody(await getCriteria(runId));

    const res = await putCriteria(runId, { ...current, criteria: [{ ...current.criteria[0]!, statement: "Anything at all" }, current.criteria[1]!] });
    expect(res.statusCode).toBe(409);
    expect((await requirements.findLatest(runId))!.revision).toBe(1);
  });

  it("returns 409 before any criteria exist", async () => {
    const { runId } = (await post(validBody({ requirement: ORIGINAL_TEXT }))).json();
    const res = await putCriteria(runId, { ...baseRequirement(), runId, revision: 1, confirmedAt: null });
    expect(res.statusCode).toBe(409);
    expect(await new RequirementRepository(t.tdb.db).findLatest(runId)).toBeNull();
  });

  it("returns 409 after the run's criteria are confirmed", async () => {
    const runId = await setupAwaitingConfirmation();
    const current = getCriteriaBody(await getCriteria(runId));
    await confirmCriteria(runId);
    const res = await putCriteria(runId, current);
    expect(res.statusCode).toBe(409);
  });

  it("returns 404 for another tenant's run", async () => {
    const other = await new RunRepository(t.tdb.db).create({
      tenantId: OTHER_TENANT_ID,
      targetUrl: "https://x.com",
      request: { ...validBody(), environment: "staging", browser: "chromium", testData: {}, secretNames: [], options: {} as never },
    });
    const res = await putCriteria(other.id, { ...baseRequirement(), runId: other.id, revision: 1, confirmedAt: null });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /v1/test-runs/:runId/criteria/confirm", () => {
  it("confirms, publishes criteria.confirmed, transitions to PLANNING, sets heartbeatAt, and enqueues execute-run", async () => {
    const runId = await setupAwaitingConfirmation();
    const res = await confirmCriteria(runId);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ revision: 1, warnings: [] });

    const requirement = await new RequirementRepository(t.tdb.db).getLatest(runId);
    expect(requirement.confirmedAt).not.toBeNull();

    const run = await new RunRepository(t.tdb.db).getById(runId);
    expect(run.lifecycle).toBe("PLANNING");
    expect(run.heartbeatAt).toBeInstanceOf(Date);

    expect(t.queue.execute).toContain(runId);

    const events = await new EventRepository(t.tdb.db).listAfter(runId, 0);
    const confirmed = events.find((e) => e.type === "criteria.confirmed");
    expect(confirmed).toBeDefined();
    expect(confirmed!.payload).toEqual({ revision: 1 });
    expect(confirmed!.message).toBe("Criteria revision 1 confirmed");
  });

  it("warns about criteria that will be reported as Inconclusive", async () => {
    const runId = await setupAwaitingConfirmation(requirementWithWarnings());
    const res = await confirmCriteria(runId);
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.warnings).toHaveLength(2);
    expect(body.warnings).toContain("Criterion AC-1 will be reported as Inconclusive");
    expect(body.warnings).toContain("Criterion AC-2 will be reported as Inconclusive");
  });

  it("returns 409 on a second confirm", async () => {
    const runId = await setupAwaitingConfirmation();
    expect((await confirmCriteria(runId)).statusCode).toBe(202);
    const second = await confirmCriteria(runId);
    expect(second.statusCode).toBe(409);
  });

  it("returns 409 when confirming a cancelled run", async () => {
    const runId = await setupAwaitingConfirmation();
    await t.app.inject({ method: "POST", url: `/v1/test-runs/${runId}/cancel`, headers: auth });
    const res = await confirmCriteria(runId);
    expect(res.statusCode).toBe(409);
  });

  it("handles concurrent confirms as exactly one 202 and one 409", async () => {
    const runId = await setupAwaitingConfirmation();
    const [a, b] = await Promise.all([confirmCriteria(runId), confirmCriteria(runId)]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([202, 409]);
  });

  it("marks the run ERRORED/INTERNAL and returns 503 when the queue is unavailable", async () => {
    const runId = await setupAwaitingConfirmation();
    t.queue.fail = true;
    const res = await confirmCriteria(runId);
    expect(res.statusCode).toBe(503);
    const run = await new RunRepository(t.tdb.db).getById(runId);
    expect(run.lifecycle).toBe("ERRORED");
    expect(run.errorCategory).toBe("INTERNAL");
    const events = await new EventRepository(t.tdb.db).listAfter(runId, 0);
    expect(events.map((e) => e.type)).toContain("run.errored");
  });

  it("returns 404 for another tenant's run", async () => {
    const other = await new RunRepository(t.tdb.db).create({
      tenantId: OTHER_TENANT_ID,
      targetUrl: "https://x.com",
      request: { ...validBody(), environment: "staging", browser: "chromium", testData: {}, secretNames: [], options: {} as never },
    });
    expect((await confirmCriteria(other.id)).statusCode).toBe(404);
  });
});

function getCriteriaBody(res: { json(): unknown }): NormalizedRequirement {
  return res.json() as NormalizedRequirement;
}
