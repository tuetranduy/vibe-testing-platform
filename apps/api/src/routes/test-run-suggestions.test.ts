import { SuggestionSetResponseSchema, TestRunSummarySchema, type SuggestionSetDraft } from "@platform/contracts";
import { EventRepository, RunRepository, SecretRepository, SuggestionRepository, schema } from "@platform/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auth, createTestApi, validBody, type TestApi } from "../test-support";

let t: TestApi;
beforeAll(async () => {
  t = await createTestApi();
});
afterAll(async () => t?.close());
beforeEach(() => {
  t.queue.fail = false;
  t.queue.afterSelection.length = 0;
});

const DRAFT: SuggestionSetDraft = {
  suggestions: [
    {
      id: "S-1",
      title: "Add a product to the cart",
      requirement: "A user can add iPhone 17 Pro to the cart from its product page, and the cart then lists it.",
      why: "Product pages have an Add to cart button.",
      needs: { secrets: [], testData: [] },
      destructive: false,
    },
    {
      id: "S-2",
      title: "Search for a product",
      requirement: "Searching for iPhone on the products page lists only products whose names contain iPhone.",
      why: "Every page has a product search form.",
      needs: { secrets: [], testData: [] },
      destructive: false,
    },
    {
      id: "S-3",
      title: "Sign in to the account",
      requirement: "A user can sign in on the login page with valid credentials and lands on their account page.",
      why: "The header links to a login page.",
      needs: { secrets: ["password"], testData: ["email"] },
      destructive: false,
    },
  ],
  pages: [
    { url: "https://shop.example.com/", title: "Home · Demo Shop", status: "READ" },
    { url: "https://shop.example.com/products", title: "Products · Demo Shop", status: "READ" },
  ],
};

const post = (body: unknown) => t.app.inject({ method: "POST", url: "/v1/test-runs", headers: auth, payload: body as object });
const getSuggestions = (runId: string) => t.app.inject({ method: "GET", url: `/v1/test-runs/${runId}/suggestions`, headers: auth });
const select = (runId: string, body: unknown) =>
  t.app.inject({ method: "POST", url: `/v1/test-runs/${runId}/suggestions/select`, headers: auth, payload: body as object });

/** A blank-requirement run walked to `to`; AWAITING_SELECTION has the survey's suggestions stored. */
async function blankRun(to: "QUEUED" | "SURVEYING" | "AWAITING_SELECTION" = "AWAITING_SELECTION", extra: Record<string, unknown> = {}): Promise<string> {
  const res = await post(validBody({ requirement: "", ...extra }));
  expect(res.statusCode).toBe(202);
  const { runId } = res.json() as { runId: string };
  if (to === "QUEUED") return runId;
  const runs = new RunRepository(t.tdb.db);
  await runs.transition(runId, "QUEUED", "SURVEYING", { heartbeatAt: new Date() });
  if (to === "SURVEYING") return runId;
  await new SuggestionRepository(t.tdb.db).save(runId, DRAFT);
  await runs.transition(runId, "SURVEYING", "AWAITING_SELECTION", { heartbeatAt: null });
  return runId;
}

describe("GET /v1/test-runs/:runId/suggestions", () => {
  it.each(["QUEUED", "SURVEYING"] as const)("409 SUGGESTIONS_NOT_READY while the run is %s", async (to) => {
    const res = await getSuggestions(await blankRun(to));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "SUGGESTIONS_NOT_READY" });
  });

  it("404 NO_SUGGESTIONS for a run created with a requirement", async () => {
    const { runId } = (await post(validBody())).json() as { runId: string };
    const res = await getSuggestions(runId);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "NO_SUGGESTIONS" });
  });

  it("returns the set, and what the run has so the UI can mark unmet needs", async () => {
    const runId = await blankRun("AWAITING_SELECTION", {
      testData: { email: "qa@demo.test" },
      secrets: { password: "pw-123456" },
      options: { allowDestructiveActions: true },
    });
    const res = await getSuggestions(runId);
    expect(res.statusCode).toBe(200);
    const body = SuggestionSetResponseSchema.parse(res.json());
    expect(body.suggestions.map((s) => s.id)).toEqual(["S-1", "S-2", "S-3"]);
    expect(body.pages).toEqual(DRAFT.pages);
    expect(body.selected).toBeNull();
    expect(body.run).toEqual({ secretNames: ["password"], testDataKeys: ["email"], destructiveActionsAllowed: true });
  });
});

describe("POST /v1/test-runs/:runId/suggestions/select", () => {
  it("credentials typed into the edited test are used (V1.3.1): a new encrypted secret and test data, the password out of the text", async () => {
    const runId = await blankRun();
    const res = await select(runId, { suggestionId: "S-2", requirement: "Sign in with qa@demo.test / Qa-Pass#77 and the account page opens." });
    expect(res.statusCode).toBe(202);
    const run = await new RunRepository(t.tdb.db).getById(runId);
    expect(run.request.requirement).toBe("Sign in with qa@demo.test / [secret: password] and the account page opens.");
    expect(run.request.testData).toEqual({ email: "qa@demo.test" });
    expect(run.request.secretNames).toEqual(["password"]);
    expect(await new SecretRepository(t.tdb.db).listNames(runId)).toEqual(["password"]);
    const [row] = await t.tdb.db.select().from(schema.testRuns).where(eq(schema.testRuns.id, runId));
    expect(JSON.stringify(row)).not.toContain("Qa-Pass#77");
  });

  it("202: the run is ANALYZING_REQUIREMENT, its requirement the suggestion's text; analysis queued; suggestion.selected without the text", async () => {
    const runId = await blankRun();
    const res = await select(runId, { suggestionId: "S-2" });

    expect(res.statusCode).toBe(202);
    const summary = TestRunSummarySchema.parse(res.json());
    expect(summary.lifecycle).toBe("ANALYZING_REQUIREMENT");
    expect(summary.requirementPreview).toBe(DRAFT.suggestions[1]!.requirement);
    expect(t.queue.afterSelection).toEqual([runId]);
    const run = await new RunRepository(t.tdb.db).getById(runId);
    expect(run.request.requirement).toBe(DRAFT.suggestions[1]!.requirement);
    expect(run.heartbeatAt).toBeInstanceOf(Date);
    const events = await new EventRepository(t.tdb.db).listAfter(runId, 0, 50);
    expect(events.at(-1)).toMatchObject({
      type: "suggestion.selected",
      stage: "AWAITING_SELECTION",
      message: "Suggestion S-2 selected",
      payload: { suggestionId: "S-2", edited: false },
    });
    expect(JSON.stringify(events)).not.toContain(DRAFT.suggestions[1]!.requirement);
    expect(SuggestionSetResponseSchema.parse((await getSuggestions(runId)).json()).selected).toEqual({ suggestionId: "S-2", edited: false });
  });

  it("an edited text becomes the requirement (trimmed) and the choice is marked edited", async () => {
    const runId = await blankRun();
    const edited = "Searching for Pixel on the products page lists Pixel 11 and nothing else.";
    const res = await select(runId, { suggestionId: "S-2", requirement: `  ${edited}  ` });
    expect(res.statusCode).toBe(202);
    expect((await new RunRepository(t.tdb.db).getById(runId)).request.requirement).toBe(edited);
    const events = await new EventRepository(t.tdb.db).listAfter(runId, 0, 50);
    expect(events.at(-1)).toMatchObject({ message: "Suggestion S-2 selected (edited)", payload: { suggestionId: "S-2", edited: true } });
  });

  it("a secret value typed into the edit is masked before it is stored (by fingerprint; D7: no decryption in the API)", async () => {
    const runId = await blankRun("AWAITING_SELECTION", { secrets: { password: "hunter2-long-pw" } });
    const res = await select(runId, {
      suggestionId: "S-3",
      requirement: "A user signs in with qa@demo.test and hunter2-long-pw and lands on their account page.",
    });
    expect(res.statusCode).toBe(202);
    const run = await new RunRepository(t.tdb.db).getById(runId);
    expect(run.request.requirement).toBe("A user signs in with qa@demo.test and [REDACTED] and lands on their account page.");
    expect(res.body).not.toContain("hunter2-long-pw");
  });

  it("the suggestion's own text sent back is not an edit", async () => {
    const runId = await blankRun();
    await select(runId, { suggestionId: "S-1", requirement: ` ${DRAFT.suggestions[0]!.requirement} ` });
    expect(SuggestionSetResponseSchema.parse((await getSuggestions(runId)).json()).selected).toEqual({ suggestionId: "S-1", edited: false });
  });

  it.each(["QUEUED", "SURVEYING"] as const)("409 RUN_NOT_AWAITING_SELECTION while the run is %s", async (to) => {
    const res = await select(await blankRun(to), { suggestionId: "S-1" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "RUN_NOT_AWAITING_SELECTION" });
  });

  it("409 RUN_NOT_AWAITING_SELECTION once a test was chosen, and for a run created with a requirement", async () => {
    const runId = await blankRun();
    expect((await select(runId, { suggestionId: "S-1" })).statusCode).toBe(202);
    expect((await select(runId, { suggestionId: "S-2" })).json()).toMatchObject({ code: "RUN_NOT_AWAITING_SELECTION" });
    const { runId: withRequirement } = (await post(validBody())).json() as { runId: string };
    expect((await select(withRequirement, { suggestionId: "S-1" })).statusCode).toBe(409);
  });

  it("400 for an id that is not one of the run's suggestions, naming the field; nothing changes", async () => {
    const runId = await blankRun();
    const res = await select(runId, { suggestionId: "S-7" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "VALIDATION_FAILED", issues: [{ path: ["suggestionId"] }] });
    expect((await new RunRepository(t.tdb.db).getById(runId)).lifecycle).toBe("AWAITING_SELECTION");
    expect(t.queue.afterSelection).toEqual([]);
  });

  it.each([
    ["under 10 characters", "too short"],
    ["over 20,000 characters", "x".repeat(20_001)],
  ])("400 for a text %s", async (_name, requirement) => {
    const runId = await blankRun();
    const res = await select(runId, { suggestionId: "S-1", requirement });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "VALIDATION_FAILED", issues: [{ path: ["requirement"] }] });
    expect((await new RunRepository(t.tdb.db).getById(runId)).request.requirement).toBe("");
  });

  it("400 for a body without a suggestion id", async () => {
    const res = await select(await blankRun(), { requirement: "A user can search for products by name." });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("when the analysis can't be queued: 503 QUEUE_UNAVAILABLE, the run ERRORED / INTERNAL, its secrets purged", async () => {
    const runId = await blankRun("AWAITING_SELECTION", { secrets: { password: "pw-123456" } });
    t.queue.fail = true;
    const res = await select(runId, { suggestionId: "S-1" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: "QUEUE_UNAVAILABLE" });
    const run = await new RunRepository(t.tdb.db).getById(runId);
    expect(run).toMatchObject({ lifecycle: "ERRORED", errorCategory: "INTERNAL", errorMessage: "Queue unavailable after selection" });
    expect(await new SecretRepository(t.tdb.db).listActive(runId)).toHaveLength(0);
    expect(await new SecretRepository(t.tdb.db).listFingerprints(runId)).toHaveLength(0);
    expect((await new EventRepository(t.tdb.db).listAfter(runId, 0, 50)).at(-1)).toMatchObject({ type: "run.errored", payload: { category: "INTERNAL" } });
  });

  it("of two selections sent at once, exactly one is accepted; the other is 409 and nothing runs twice", async () => {
    const runId = await blankRun();
    const results = await Promise.all([select(runId, { suggestionId: "S-1" }), select(runId, { suggestionId: "S-2" })]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([202, 409]);
    expect(results.find((r) => r.statusCode === 409)!.json()).toMatchObject({ code: "RUN_NOT_AWAITING_SELECTION" });
    expect(t.queue.afterSelection).toEqual([runId]);
    const selections = (await new EventRepository(t.tdb.db).listAfter(runId, 0, 50)).filter((e) => e.type === "suggestion.selected");
    expect(selections).toHaveLength(1);
  });
});
