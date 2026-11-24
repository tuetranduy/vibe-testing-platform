import { CoverageResponseSchema, FindingsResponseSchema, type StoredFinding } from "@platform/contracts";
import { ExplorationStepRepository, FindingRepository, RunRepository, SuggestionRepository } from "@platform/db";
import { OTHER_TENANT_ID, TEST_TENANT_ID } from "@platform/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, createTestApi, validBody, type TestApi } from "../test-support";

let t: TestApi;
beforeAll(async () => {
  t = await createTestApi();
});
afterAll(async () => t?.close());

const finding = (id: string): StoredFinding => ({
  id, source: "browser_use", title: "Help link opens a missing page",
  observation: "The Help link in the footer opened a page that says Not Found.",
  expected: "the help page opens", path: "/help", url: "https://shop.example.com/help",
  reproduction: ["Open the home page", "Click Help in the footer"], severity: "medium",
  dismissedAt: null, reproductionRunId: null, createdAt: "2026-11-24T00:00:00.000Z",
});

async function seed(tenantId = TEST_TENANT_ID): Promise<string> {
  const runs = new RunRepository(t.tdb.db);
  let runId: string;
  if (tenantId === TEST_TENANT_ID) {
    runId = ((await t.app.inject({ method: "POST", url: "/v1/test-runs", headers: auth, payload: validBody() })).json() as { runId: string }).runId;
  } else {
    // Another tenant's run, with a stored request copied from one of ours.
    const ours = await runs.getById(await seed());
    runId = (await runs.create({ tenantId, targetUrl: ours.targetUrl, request: ours.request })).id;
  }
  await new FindingRepository(t.tdb.db).saveNew(runId, [finding("F-1"), finding("F-2")]);
  return runId;
}

const list = (runId: string) => t.app.inject({ method: "GET", url: `/v1/test-runs/${runId}/findings`, headers: auth });
const act = (runId: string, findingId: string, action: "dismiss" | "reproduce") =>
  t.app.inject({ method: "POST", url: `/v1/test-runs/${runId}/findings/${findingId}/${action}`, headers: auth });

describe("exploratory findings (Phase C)", () => {
  it("lists findings as unverified hypotheses", async () => {
    const runId = await seed();
    const res = await list(runId);
    expect(res.statusCode).toBe(200);
    const body = FindingsResponseSchema.parse(res.json());
    expect(body.findings.map((f) => [f.id, f.status, f.statusReason])).toEqual([
      ["F-1", "HYPOTHESIS", "not_reviewed"],
      ["F-2", "HYPOTHESIS", "not_reviewed"],
    ]);
  });

  it("a reviewer's dismissal is recorded and audited", async () => {
    const runId = await seed();
    const res = await act(runId, "F-1", "dismiss");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: "F-1", status: "DISMISSED", statusReason: "dismissed_by_reviewer" });
    expect((await act(runId, "F-1", "reproduce")).statusCode).toBe(409);
    expect((await act(runId, "F-9", "dismiss")).statusCode).toBe(404);
  });

  it("starts one independent reproduction per finding, and only its verdict promotes the finding", async () => {
    const runId = await seed();
    const started = await act(runId, "F-2", "reproduce");
    expect(started.statusCode).toBe(202);
    const { run, finding: linked } = started.json() as { run: { runId: string }; finding: { status: string; statusReason: string } };
    expect(linked).toMatchObject({ status: "HYPOTHESIS", statusReason: "reproduction_running" });
    // Idempotent: a second click returns the same reproduction run.
    expect(((await act(runId, "F-2", "reproduce")).json() as { run: { runId: string } }).run.runId).toBe(run.runId);

    const runs = new RunRepository(t.tdb.db);
    const reproduction = await runs.getById(run.runId);
    expect(reproduction.targetUrl).toBe("https://shop.example.com/help");
    expect(reproduction.request.reproducesFinding).toEqual({ runId, findingId: "F-2" });
    expect(reproduction.request.options).toMatchObject({ autoConfirmCriteria: false, allowDestructiveActions: false });
    expect(reproduction.request.options.autonomousDiscovery).toBeUndefined();
    expect(reproduction.request.requirement).toContain("Verify that the help page opens.");
    expect(reproduction.request.requirement).not.toContain("Not Found");

    // A reproduction that never reached a verdict leaves the finding unconfirmed, never reproduced.
    await runs.transition(run.runId, "QUEUED", "CANCELLED", { cancelReason: "USER_REQUESTED" });
    const afterCancel = FindingsResponseSchema.parse((await list(runId)).json()).findings.find((f) => f.id === "F-2");
    expect(afterCancel).toMatchObject({ status: "INCONCLUSIVE", statusReason: "reproduction_failed_to_run" });
    // The reviewer may still dismiss it.
    expect((await act(runId, "F-2", "dismiss")).statusCode).toBe(200);
  });

  it("another tenant's findings are invisible", async () => {
    const theirs = await seed(OTHER_TENANT_ID);
    expect((await list(theirs)).statusCode).toBe(404);
    expect((await act(theirs, "F-1", "reproduce")).statusCode).toBe(404);
  });
});

describe("recurring findings and the site's coverage graph (Phase C)", () => {
  it("links the same problem across runs without changing either run's status", async () => {
    const first = await seed();
    const second = await seed();
    await t.app.inject({ method: "POST", url: `/v1/test-runs/${first}/findings/F-1/dismiss`, headers: auth });
    const body = FindingsResponseSchema.parse((await list(second)).json());
    const f1 = body.findings.find((f) => f.id === "F-1")!;
    expect(f1.status).toBe("HYPOTHESIS");
    expect(f1.recurrence).toMatchObject({ dismissedElsewhere: true, reproducedElsewhere: false });
    expect(f1.recurrence!.otherRuns).toBeGreaterThanOrEqual(1);
  });

  it("maps pages discovery found against pages a verified golden path reached, and names the gaps", async () => {
    const runId = await seed();
    await new SuggestionRepository(t.tdb.db).save(runId, {
      pages: [{ url: "https://shop.example.com/", title: "Home", status: "READ" }],
      suggestions: [{
        id: "S-1", title: "Add tea to the cart", requirement: "A visitor can add tea to the cart.", why: "Seen.",
        needs: { secrets: [], testData: [] }, destructive: false,
        discovery: { engine: "browser_use", relevantPaths: ["/tea", "/cart"] },
      }],
    });
    await new ExplorationStepRepository(t.tdb.db).insert({
      id: "step_cov_1", runId, index: 0, plannedStepId: "PS-1", kind: "navigate", instruction: "Navigate to https://shop.example.com/tea",
      element: null, inputRef: null, onGoldenPath: true, urlBefore: "about:blank", urlAfter: "https://shop.example.com/tea?ref=1",
      outcome: "SUCCESS", blockReason: null, error: null, startedAt: "2026-11-24T00:00:00.000Z", durationMs: 5, artifactIds: [], llm: null,
    });
    const res = await t.app.inject({ method: "GET", url: "/v1/discovery/coverage?url=https%3A%2F%2Fshop.example.com%2Fanything", headers: auth });
    expect(res.statusCode).toBe(200);
    const coverage = CoverageResponseSchema.parse(res.json());
    expect(coverage.origin).toBe("https://shop.example.com");
    const byPath = Object.fromEntries(coverage.pages.map((p) => [p.path, p]));
    expect(byPath["/tea"]).toMatchObject({ tested: 1 });
    expect(byPath["/tea"]!.discovered).toBeGreaterThanOrEqual(1);
    expect(byPath["/help"]!.findings).toBeGreaterThanOrEqual(2);
    expect(coverage.edges).toContainEqual(expect.objectContaining({ from: "/tea", to: "/cart" }));
    expect(coverage.gaps).toContain("/cart");
    expect(coverage.gaps).not.toContain("/tea");
    // Another site's runs never mix in.
    const other = CoverageResponseSchema.parse((await t.app.inject({ method: "GET", url: "/v1/discovery/coverage?url=https%3A%2F%2Fother.example.com%2F", headers: auth })).json());
    expect(other).toMatchObject({ runs: 0, pages: [] });
    expect((await t.app.inject({ method: "GET", url: "/v1/discovery/coverage?url=nope", headers: auth })).statusCode).toBe(400);
  });
});
