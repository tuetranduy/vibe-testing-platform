import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SuggestionSetDraft } from "@platform/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_FOLDER } from "./client";
import { StaleTransitionError, UnknownSuggestionError } from "./errors";
import { RunRepository } from "./run-repository";
import { SuggestionRepository } from "./suggestion-repository";
import { storedRequest } from "./test-helpers";
import { TEST_TENANT_ID, createTestDatabase, type TestDatabase } from "./testing";

let tdb: TestDatabase;
let runs: RunRepository;
let suggestions: SuggestionRepository;
beforeAll(async () => {
  tdb = await createTestDatabase();
  runs = new RunRepository(tdb.db);
  suggestions = new SuggestionRepository(tdb.db);
});
afterAll(async () => tdb?.drop());

const draft = (): SuggestionSetDraft => ({
  suggestions: [
    {
      id: "S-1",
      title: "Add a product to the cart",
      requirement: "A user can add iPhone 17 Pro to the cart from its product page.",
      why: "Product pages have an Add to cart button.",
      needs: { secrets: [], testData: [] },
      destructive: false,
    },
    {
      id: "S-2",
      title: "Sign in",
      requirement: "A user can sign in on the login page and sees their account page.",
      why: "The header links to a login page.",
      needs: { secrets: ["password"], testData: ["email"] },
      destructive: false,
    },
  ],
  pages: [
    { url: "https://shop.example.com/", title: "Home", status: "READ" },
    { url: "https://shop.example.com/account", title: "", status: "SKIPPED" },
  ],
});

const blankRun = () =>
  runs.create({ tenantId: TEST_TENANT_ID, targetUrl: "https://shop.example.com", request: storedRequest({ requirement: "" }) });

/** A blank-requirement run, surveyed, waiting for the user's choice. */
async function awaitingSelection() {
  const run = await blankRun();
  await runs.transition(run.id, "QUEUED", "SURVEYING", { heartbeatAt: new Date() });
  await suggestions.save(run.id, draft());
  await runs.transition(run.id, "SURVEYING", "AWAITING_SELECTION", { heartbeatAt: null });
  return run;
}

describe("SuggestionRepository", () => {
  it("saves a run's suggestions with nothing selected, and reads them back", async () => {
    const run = await awaitingSelection();
    expect(await suggestions.get(run.id)).toEqual({ ...draft(), selected: null });
  });

  it("has nothing for a run without suggestions", async () => {
    const run = await runs.create({ tenantId: TEST_TENANT_ID, targetUrl: "https://shop.example.com", request: storedRequest() });
    expect(await suggestions.get(run.id)).toBeNull();
  });

  it("refuses a set the contract rejects (duplicate ids) and stores nothing", async () => {
    const run = await blankRun();
    const bad = draft();
    bad.suggestions[1] = { ...bad.suggestions[1]!, id: "S-1" };
    await expect(suggestions.save(run.id, bad)).rejects.toThrow();
    expect(await suggestions.get(run.id)).toBeNull();
  });

  it("select writes the choice, the run's requirement and AWAITING_SELECTION → ANALYZING_REQUIREMENT with a fresh heartbeat, together", async () => {
    const run = await awaitingSelection();
    const text = "A user can sign in with valid credentials and sees their email on the account page.";
    const { run: moved, set } = await suggestions.select(run.id, { suggestionId: "S-2", requirement: text, edited: true });

    expect(moved.lifecycle).toBe("ANALYZING_REQUIREMENT");
    expect(moved.heartbeatAt).toBeInstanceOf(Date);
    expect(moved.request.requirement).toBe(text);
    expect(set.selected).toEqual({ suggestionId: "S-2", edited: true });
    expect((await suggestions.get(run.id))!.selected).toEqual({ suggestionId: "S-2", edited: true });
    // Only the requirement changed in the stored request.
    expect((await runs.getById(run.id)).request).toEqual({ ...storedRequest({ requirement: "" }), requirement: text });
  });

  it("does neither when the run left AWAITING_SELECTION (e.g. cancelled): StaleTransitionError", async () => {
    const run = await awaitingSelection();
    await runs.transition(run.id, "AWAITING_SELECTION", "CANCELLED", { cancelReason: "USER_REQUESTED" });
    const err = await suggestions
      .select(run.id, { suggestionId: "S-1", requirement: draft().suggestions[0]!.requirement, edited: false })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaleTransitionError);
    expect((err as StaleTransitionError).actual).toBe("CANCELLED");
    expect((await runs.getById(run.id)).request.requirement).toBe("");
    expect((await suggestions.get(run.id))!.selected).toBeNull();
  });

  it("rejects an id that is not one of the run's suggestions, writing nothing", async () => {
    const run = await awaitingSelection();
    await expect(
      suggestions.select(run.id, { suggestionId: "S-7", requirement: "Some text of ten or more.", edited: true }),
    ).rejects.toBeInstanceOf(UnknownSuggestionError);
    const after = await runs.getById(run.id);
    expect(after.lifecycle).toBe("AWAITING_SELECTION");
    expect(after.request.requirement).toBe("");
  });

  it("of two concurrent selections exactly one wins; the other finds the run moved on", async () => {
    const run = await awaitingSelection();
    const [s1, s2] = draft().suggestions;
    const results = await Promise.allSettled([
      suggestions.select(run.id, { suggestionId: s1!.id, requirement: s1!.requirement, edited: false }),
      suggestions.select(run.id, { suggestionId: s2!.id, requirement: s2!.requirement, edited: false }),
    ]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]!.reason).toBeInstanceOf(StaleTransitionError);
    const chosen = (await suggestions.get(run.id))!.selected!.suggestionId;
    expect((await runs.getById(run.id)).request.requirement).toBe(draft().suggestions.find((s) => s.id === chosen)!.requirement);
  });

  it("the suggestions go with their run", async () => {
    const run = await awaitingSelection();
    await tdb.pool.query("DELETE FROM test_runs WHERE id = $1", [run.id]);
    expect(await suggestions.get(run.id)).toBeNull();
  });
});

describe("migration 0002_suggest_tests", () => {
  it("adds SURVEYING and AWAITING_SELECTION before ANALYZING_REQUIREMENT", async () => {
    const res = await tdb.pool.query(
      "SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'run_lifecycle' ORDER BY e.enumsortorder",
    );
    expect(res.rows.map((r) => r.enumlabel).slice(0, 4)).toEqual(["QUEUED", "SURVEYING", "AWAITING_SELECTION", "ANALYZING_REQUIREMENT"]);
  });

  it("only adds the enum values: nothing in it uses them (Postgres can't in the transaction that adds them)", () => {
    const statements = readFileSync(join(MIGRATIONS_FOLDER, "0002_suggest_tests.sql"), "utf8")
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);
    expect(statements).toContain(`ALTER TYPE "public"."run_lifecycle" ADD VALUE 'SURVEYING' BEFORE 'ANALYZING_REQUIREMENT';`);
    expect(statements).toContain(`ALTER TYPE "public"."run_lifecycle" ADD VALUE 'AWAITING_SELECTION' BEFORE 'ANALYZING_REQUIREMENT';`);
    expect(statements).toContain(`ALTER TYPE "public"."cancel_reason" ADD VALUE 'SELECTION_EXPIRED';`);
    const uses = statements.filter((s) => /'(SURVEYING|AWAITING_SELECTION|SELECTION_EXPIRED)'/.test(s) && !/^ALTER TYPE \S+ ADD VALUE/.test(s));
    expect(uses).toEqual([]);
  });
});
