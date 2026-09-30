import type { SiteAnalysisDraft } from "@platform/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RunInvariantError } from "./errors";
import { RunRepository } from "./run-repository";
import { SiteAnalysisRepository } from "./site-analysis-repository";
import { storedRequest } from "./test-helpers";
import { TEST_TENANT_ID, createTestDatabase, type TestDatabase } from "./testing";

let tdb: TestDatabase;
let runs: RunRepository;
let analyses: SiteAnalysisRepository;
beforeAll(async () => {
  tdb = await createTestDatabase();
  runs = new RunRepository(tdb.db);
  analyses = new SiteAnalysisRepository(tdb.db);
});
afterAll(async () => tdb?.drop());

const newRun = (testData: Record<string, string | number> = {}) =>
  runs.create({ tenantId: TEST_TENANT_ID, targetUrl: "https://shop.example.com", request: storedRequest({ testData }) });

const draft = (): SiteAnalysisDraft => ({
  status: "READ",
  reason: null,
  pages: [{ url: "https://shop.example.com/", title: "Home", status: "READ" }],
  checks: [{ criterionId: "AC-1", status: "FOUND", note: "The home page has a sign-up form" }],
  testData: [
    { key: "email", value: "qa.abc123@example.com", description: "Email to sign up with", source: "GENERATED" },
    { key: "productName", value: "iPhone 17 Pro", description: "A listed product", source: "SITE" },
  ],
});

describe("SiteAnalysisRepository", () => {
  it("saves, replaces and reads a run's analysis", async () => {
    const run = await newRun();
    expect(await analyses.get(run.id)).toBeNull();
    const saved = await analyses.save(run.id, draft());
    expect(saved.appliedKeys).toEqual([]);
    expect(await analyses.get(run.id)).toEqual(saved);

    await analyses.save(run.id, { ...draft(), status: "UNAVAILABLE", reason: "The start page did not load", pages: [] });
    expect((await analyses.get(run.id))?.status).toBe("UNAVAILABLE");
  });

  it("records applied keys, only among its suggestions", async () => {
    const run = await newRun();
    await analyses.save(run.id, draft());
    await analyses.markApplied(run.id, ["email", "notSuggested"]);
    await analyses.markApplied(run.id, ["email"]);
    expect((await analyses.get(run.id))?.appliedKeys).toEqual(["email"]);
    await expect(analyses.markApplied((await newRun()).id, ["email"])).resolves.toBeUndefined();
  });
});

describe("RunRepository.mergeTestData", () => {
  it("merges values over the run's own test data", async () => {
    const run = await newRun({ quantity: 1, city: "Oslo" });
    const merged = await runs.mergeTestData(run.id, { email: "qa@example.com", quantity: 2 });
    expect(merged).toEqual({ quantity: 2, city: "Oslo", email: "qa@example.com" });
    expect((await runs.getById(run.id)).request.testData).toEqual(merged);
  });

  it("refuses more than 50 entries in all, writing nothing", async () => {
    const run = await newRun(Object.fromEntries(Array.from({ length: 49 }, (_, i) => [`k${i}`, i])));
    await expect(runs.mergeTestData(run.id, { a: 1, b: 2 })).rejects.toBeInstanceOf(RunInvariantError);
    expect(Object.keys((await runs.getById(run.id)).request.testData)).toHaveLength(49);
  });
});
