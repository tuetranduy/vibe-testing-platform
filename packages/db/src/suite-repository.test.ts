import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RunRepository } from "./run-repository";
import { EntryExistsError, SuiteFullError, SuiteRepository, SuiteRunRepository } from "./suite-repository";
import { NameTakenError } from "./test-data-set-repository";
import { OTHER_TENANT_ID, TEST_TENANT_ID, createTestDatabase, storedRequest, type TestDatabase } from "./testing";
import { UserRepository } from "./user-repository";

let tdb: TestDatabase;
beforeAll(async () => {
  tdb = await createTestDatabase();
});
afterAll(async () => tdb?.drop());

const tenant = { tenantId: TEST_TENANT_ID };
const newSuite = (name: string, ownerUserId: string | null = null, tenantId = TEST_TENANT_ID) =>
  new SuiteRepository(tdb.db).create({ tenantId, name, description: "", credentialProfileId: null, ownerUserId });
const newRun = (overrides: { rerunOf?: string; suiteRunId?: string } = {}) =>
  new RunRepository(tdb.db).create({
    tenantId: TEST_TENANT_ID,
    targetUrl: "https://shop.example.com",
    request: storedRequest(overrides.rerunOf ? { rerunOf: overrides.rerunOf } : {}),
    ...(overrides.suiteRunId ? { suiteRunId: overrides.suiteRunId } : {}),
  });

async function user(email: string) {
  return new UserRepository(tdb.db).create({ tenantId: TEST_TENANT_ID, email, name: email, passwordHash: "x", role: "member" });
}

describe("SuiteRepository", () => {
  it("creates, lists by name, finds case-insensitively, scopes to the owner and tenant, updates and removes", async () => {
    const ann = await user("ann-suites@example.com");
    const b = await newSuite("Checkout smoke", ann.id);
    const a = await newSuite("account pages");
    await newSuite("Other tenant suite", null, OTHER_TENANT_ID);
    const repo = new SuiteRepository(tdb.db);

    expect((await repo.list(tenant)).map((s) => s.name)).toEqual(["account pages", "Checkout smoke"]);
    expect((await repo.list({ tenantId: TEST_TENANT_ID, ownerUserId: ann.id })).map((s) => s.id)).toEqual([b.id]);
    expect(await repo.find({ tenantId: TEST_TENANT_ID, ownerUserId: ann.id }, a.id)).toBeNull();
    expect(await repo.find({ tenantId: OTHER_TENANT_ID }, b.id)).toBeNull();
    expect((await repo.findByName(tenant, "  CHECKOUT smoke "))?.id).toBe(b.id);

    await expect(newSuite("checkout SMOKE")).rejects.toBeInstanceOf(NameTakenError);
    const updated = await repo.update(tenant, b.id, { name: "Checkout", description: "Paying", credentialProfileId: null });
    expect(updated).toMatchObject({ name: "Checkout", description: "Paying" });
    await expect(repo.update(tenant, a.id, { name: "checkout", description: "", credentialProfileId: null })).rejects.toBeInstanceOf(NameTakenError);

    expect(await repo.remove({ tenantId: TEST_TENANT_ID, ownerUserId: ann.id }, a.id)).toBe(false);
    expect(await repo.remove(tenant, a.id)).toBe(true);
    expect(await repo.find(tenant, a.id)).toBeNull();
  });

  it("appends entries in order, refuses duplicates and a full suite, reorders only a full permutation, removes", async () => {
    const repo = new SuiteRepository(tdb.db);
    const suite = await newSuite("Ordering");
    const [r1, r2, r3] = [await newRun(), await newRun(), await newRun()];
    await repo.addEntry(suite.id, { sourceRunId: r1.id, confirmDestructive: false, addedBy: null });
    await repo.addEntry(suite.id, { sourceRunId: r2.id, confirmDestructive: true, addedBy: null });
    await repo.addEntry(suite.id, { sourceRunId: r3.id, confirmDestructive: false, addedBy: null });
    await expect(repo.addEntry(suite.id, { sourceRunId: r2.id, confirmDestructive: false, addedBy: null })).rejects.toBeInstanceOf(
      EntryExistsError,
    );
    expect((await repo.entries(suite.id)).map((e) => [e.sourceRunId, e.position, e.confirmDestructive])).toEqual([
      [r1.id, 1, false],
      [r2.id, 2, true],
      [r3.id, 3, false],
    ]);
    expect(await repo.entryCounts([suite.id])).toEqual(new Map([[suite.id, 3]]));

    expect(await repo.reorder(suite.id, [r3.id, r1.id])).toBe(false);
    expect(await repo.reorder(suite.id, [r3.id, r1.id, r1.id])).toBe(false);
    expect(await repo.reorder(suite.id, [r3.id, r1.id, r2.id])).toBe(true);
    expect((await repo.entries(suite.id)).map((e) => e.sourceRunId)).toEqual([r3.id, r1.id, r2.id]);

    expect(await repo.removeEntry(suite.id, r1.id)).toBe(true);
    expect(await repo.removeEntry(suite.id, r1.id)).toBe(false);
    // New entries go after the highest position, even after a removal.
    const r4 = await newRun();
    expect((await repo.addEntry(suite.id, { sourceRunId: r4.id, confirmDestructive: false, addedBy: null })).position).toBe(4);
    expect((await repo.entriesOf([suite.id])).get(suite.id)!.map((e) => e.sourceRunId)).toEqual([r3.id, r2.id, r4.id]);
  });

  it("holds at most 50 entries", async () => {
    const repo = new SuiteRepository(tdb.db);
    const suite = await newSuite("Full");
    for (let i = 0; i < 50; i++) {
      await repo.addEntry(suite.id, { sourceRunId: (await newRun()).id, confirmDestructive: false, addedBy: null });
    }
    await expect(repo.addEntry(suite.id, { sourceRunId: (await newRun()).id, confirmDestructive: false, addedBy: null })).rejects.toBeInstanceOf(
      SuiteFullError,
    );
  });
});

describe("SuiteRunRepository", () => {
  it("settles once every child is terminal, with the aggregated verdict, exactly once", async () => {
    const suiteRuns = new SuiteRunRepository(tdb.db);
    const runs = new RunRepository(tdb.db);
    const suite = await newSuite("Settling");
    const sr = await suiteRuns.create({ tenantId: TEST_TENANT_ID, suiteId: suite.id, suiteName: suite.name, trigger: "manual", ownerUserId: null });
    const src = await newRun();
    const a = await newRun({ rerunOf: src.id, suiteRunId: sr.id });
    const b = await newRun({ rerunOf: src.id, suiteRunId: sr.id });
    expect((await suiteRuns.children(sr.id)).map((r) => r.id)).toEqual([a.id, b.id]);

    await runs.transition(a.id, "QUEUED", "RUNNING_PLAYWRIGHT");
    await runs.transition(a.id, "RUNNING_PLAYWRIGHT", "GENERATING_REPORT");
    await runs.transition(a.id, "GENERATING_REPORT", "COMPLETED", { verdict: "PASSED" });
    expect(await suiteRuns.settle(sr.id)).toBeNull();

    await runs.transition(b.id, "QUEUED", "ERRORED", { errorCategory: "INTERNAL" });
    const settled = await suiteRuns.settle(sr.id);
    expect(settled).toMatchObject({ status: "COMPLETED", verdict: "INCONCLUSIVE" });
    expect(settled!.finishedAt).toBeInstanceOf(Date);
    expect(await suiteRuns.settle(sr.id)).toBeNull();
  });

  it("counts a running suite run as one active run and its children as none", async () => {
    const suiteRuns = new SuiteRunRepository(tdb.db);
    const runs = new RunRepository(tdb.db);
    const before = await runs.countActive(TEST_TENANT_ID);
    const suite = await newSuite("Admission");
    const sr = await suiteRuns.create({ tenantId: TEST_TENANT_ID, suiteId: suite.id, suiteName: suite.name, trigger: "manual", ownerUserId: null });
    const src = await newRun();
    const children = [await newRun({ rerunOf: src.id, suiteRunId: sr.id }), await newRun({ rerunOf: src.id, suiteRunId: sr.id })];
    // The source is QUEUED too: one standalone run plus one suite run.
    expect(await runs.countActive(TEST_TENANT_ID)).toBe(before + 2);
    for (const c of children) await runs.transition(c.id, "QUEUED", "CANCELLED", { cancelReason: "USER_REQUESTED" });
    await suiteRuns.settle(sr.id);
    await runs.transition(src.id, "QUEUED", "CANCELLED", { cancelReason: "USER_REQUESTED" });
    expect(await runs.countActive(TEST_TENANT_ID)).toBe(before);
  });

  it("finds each entry's newest result in the suite, each suite's newest run, and runs by owner", async () => {
    const suiteRuns = new SuiteRunRepository(tdb.db);
    const ann = await user("ann-suite-runs@example.com");
    const suite = await newSuite("History");
    const src = await newRun();
    const first = await suiteRuns.create({ tenantId: TEST_TENANT_ID, suiteId: suite.id, suiteName: suite.name, trigger: "manual", ownerUserId: null });
    await newRun({ rerunOf: src.id, suiteRunId: first.id });
    const second = await suiteRuns.create({ tenantId: TEST_TENANT_ID, suiteId: suite.id, suiteName: suite.name, trigger: "api", ownerUserId: ann.id });
    const newest = await newRun({ rerunOf: src.id, suiteRunId: second.id });

    expect((await suiteRuns.lastResultsBySource(TEST_TENANT_ID, suite.id)).get(src.id)?.id).toBe(newest.id);
    expect((await suiteRuns.latestFor(TEST_TENANT_ID, [suite.id])).get(suite.id)?.id).toBe(second.id);
    expect((await suiteRuns.listForSuite(tenant, suite.id, 10)).map((r) => r.id)).toEqual([second.id, first.id]);
    expect((await suiteRuns.listForSuite({ tenantId: TEST_TENANT_ID, ownerUserId: ann.id }, suite.id, 10)).map((r) => r.id)).toEqual([second.id]);
    expect(await suiteRuns.find({ tenantId: TEST_TENANT_ID, ownerUserId: ann.id }, first.id)).toBeNull();
    expect(await suiteRuns.find({ tenantId: OTHER_TENANT_ID }, second.id)).toBeNull();
  });
});
