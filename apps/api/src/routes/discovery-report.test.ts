import { TestReportSchema, type DiscoverySummary } from "@platform/contracts";
import { EventRepository, RunRepository, SuggestionRepository, schema } from "@platform/db";
import { OTHER_TENANT_ID, TEST_TENANT_ID } from "@platform/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, createTestApi, type TestApi } from "../test-support";

/** The report's Browser Use section: tenant-scoped, latest outcome, retained only as long as its run. */
let t: TestApi;
beforeAll(async () => {
  t = await createTestApi();
});
afterAll(async () => t?.close());

const fixtureUrl = "http://127.0.0.1:4599/";
const request = {
  targetUrl: fixtureUrl,
  requirement: "",
  environment: "staging" as const,
  browser: "chromium" as const,
  testData: {},
  secretNames: [],
  options: { autonomousDiscovery: true } as never,
};
const suggestion = (id: string, discovery: boolean) => ({
  id, title: `Idea ${id}`, requirement: `A visitor can check idea ${id}.`, why: "Observed.",
  needs: { secrets: [], testData: [] }, destructive: false,
  ...(discovery ? { discovery: { engine: "browser_use" as const, relevantPaths: ["/", "/products.html"] } } : {}),
});
const completed: DiscoverySummary = {
  status: "COMPLETED", reason: "ok", attempted: true, candidateCount: 3, acceptedCount: 1, pageCount: 2, fallbackUsed: false,
};
const timedOut: DiscoverySummary = {
  status: "TIMED_OUT", reason: "worker_deadline", attempted: true, candidateCount: 0, acceptedCount: 0, pageCount: 0, fallbackUsed: true,
};

/** A cancelled (terminal) opted-in run with discovery events in the given order and a selected discovery idea. */
async function seed(tenantId: string, outcomes: DiscoverySummary[]) {
  const runs = new RunRepository(t.tdb.db);
  let run = await runs.create({ tenantId, targetUrl: fixtureUrl, request });
  run = await runs.transition(run.id, "QUEUED", "SURVEYING");
  const events = new EventRepository(t.tdb.db);
  for (const payload of outcomes) {
    await events.append({
      runId: run.id, stage: "SURVEYING", message: "Browser Use outcome",
      ...(payload.status === "COMPLETED" ? { type: "discovery.completed" as const, payload } : { type: "discovery.failed" as const, payload }),
    });
  }
  const suggestions = new SuggestionRepository(t.tdb.db);
  await suggestions.save(run.id, { pages: [{ url: fixtureUrl, title: "Fixture", status: "READ" }], suggestions: [suggestion("S-1", false), suggestion("S-2", true)] });
  run = await runs.transition(run.id, "SURVEYING", "AWAITING_SELECTION");
  await suggestions.select(run.id, { suggestionId: "S-2", requirement: suggestion("S-2", true).requirement, edited: false });
  run = await runs.getById(run.id);
  await runs.transition(run.id, run.lifecycle, "CANCELLED", { cancelReason: "USER_REQUESTED" });
  return run.id;
}

const getReport = (runId: string) => t.app.inject({ method: "GET", url: `/v1/test-runs/${runId}/report`, headers: auth });

describe("the report's Browser Use section", () => {
  it("shows the latest terminal outcome by sequence, not any success recorded earlier", async () => {
    const report = TestReportSchema.parse((await getReport(await seed(TEST_TENANT_ID, [completed, timedOut]))).json());
    expect(report.discovery).toMatchObject({ status: "TIMED_OUT", reason: "worker_deadline", fallbackUsed: true });
    const later = TestReportSchema.parse((await getReport(await seed(TEST_TENANT_ID, [timedOut, completed]))).json());
    expect(later.discovery).toMatchObject({ status: "COMPLETED", fallbackUsed: false, selectedSuggestion: { id: "S-2", edited: false } });
  });

  it("is invisible to another tenant: the whole report is 404", async () => {
    const other = await seed(OTHER_TENANT_ID, [completed]);
    const res = await getReport(other);
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("Idea S-2");
  });

  it("is retained exactly as long as its run: deleting the run removes the discovery events and suggestions", async () => {
    const runId = await seed(TEST_TENANT_ID, [completed]);
    const count = async () => ({
      events: (await t.tdb.db.select().from(schema.testEvents).where(eq(schema.testEvents.runId, runId)))
        .filter((row) => row.type.startsWith("discovery.")).length,
      suggestions: (await t.tdb.db.select().from(schema.runSuggestions).where(eq(schema.runSuggestions.runId, runId))).length,
    });
    expect(await count()).toEqual({ events: 1, suggestions: 1 });
    await t.tdb.db.delete(schema.testRuns).where(eq(schema.testRuns.id, runId));
    expect(await count()).toEqual({ events: 0, suggestions: 0 });
  });
});
