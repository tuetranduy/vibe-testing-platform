import { ArtifactSensitivitySchema, ArtifactTypeSchema, CancelReasonSchema, CriterionStatusSchema, ErrorCategorySchema, RunLifecycleSchema, RunVerdictSchema } from "@platform/contracts";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NotFoundError, RunInvariantError, StaleTransitionError, IllegalRunTransitionError } from "./errors";
import { RunRepository, toRunSummary } from "./run-repository";
import { SecretRepository } from "./secret-repository";
import { storedRequest } from "./test-helpers";
import { OTHER_TENANT_ID, TEST_TENANT_ID, createTestDatabase, type TestDatabase } from "./testing";

let tdb: TestDatabase;
let runs: RunRepository;

beforeAll(async () => {
  tdb = await createTestDatabase();
  runs = new RunRepository(tdb.db);
});
afterAll(async () => tdb?.drop());

const create = (tenantId = TEST_TENANT_ID) =>
  runs.create({ tenantId, targetUrl: "https://shop.example.com", request: storedRequest() });

describe("RunRepository", () => {
  it("creates runs as QUEUED without a verdict", async () => {
    const run = await create();
    expect(run.id).toMatch(/^run_/);
    expect(run.lifecycle).toBe("QUEUED");
    expect(run.verdict).toBeNull();
    expect(run.errorCategory).toBeNull();
    expect(toRunSummary(run).requirementPreview).toContain("add a product");
  });

  it("resolves concurrent transitions by CAS: exactly one wins", async () => {
    const run = await create();
    const results = await Promise.allSettled([
      runs.transition(run.id, "QUEUED", "ANALYZING_REQUIREMENT"),
      runs.transition(run.id, "QUEUED", "ANALYZING_REQUIREMENT"),
      runs.transition(run.id, "QUEUED", "ANALYZING_REQUIREMENT"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(2);
    for (const r of rejected) expect(r.reason).toBeInstanceOf(StaleTransitionError);
  });

  it("rejects illegal transitions before touching the database", async () => {
    const run = await create();
    await expect(runs.transition(run.id, "QUEUED", "VERIFYING")).rejects.toBeInstanceOf(IllegalRunTransitionError);
  });

  it("requires a verdict for COMPLETED and only for COMPLETED", async () => {
    const run = await create();
    await runs.transition(run.id, "QUEUED", "ANALYZING_REQUIREMENT");
    await runs.transition(run.id, "ANALYZING_REQUIREMENT", "PLANNING");
    await runs.transition(run.id, "PLANNING", "GENERATING_REPORT");
    await expect(runs.transition(run.id, "GENERATING_REPORT", "COMPLETED")).rejects.toBeInstanceOf(RunInvariantError);
    await expect(
      runs.transition(run.id, "GENERATING_REPORT", "ERRORED", { errorCategory: "INTERNAL", verdict: "PASSED" }),
    ).rejects.toBeInstanceOf(RunInvariantError);
    const done = await runs.transition(run.id, "GENERATING_REPORT", "COMPLETED", { verdict: "BLOCKED" });
    expect(done.verdict).toBe("BLOCKED");
    expect(done.finishedAt).toBeInstanceOf(Date);
  });

  it("requires an errorCategory for ERRORED and a reason for CANCELLED", async () => {
    const a = await create();
    await expect(runs.transition(a.id, "QUEUED", "ERRORED")).rejects.toBeInstanceOf(RunInvariantError);
    const errored = await runs.transition(a.id, "QUEUED", "ERRORED", { errorCategory: "INTERNAL", errorMessage: "boom" });
    expect(errored.errorCategory).toBe("INTERNAL");
    const b = await create();
    await expect(runs.transition(b.id, "QUEUED", "CANCELLED")).rejects.toBeInstanceOf(RunInvariantError);
    const c = await runs.transition(b.id, "QUEUED", "CANCELLED", { cancelReason: "USER_REQUESTED" });
    expect(toRunSummary(c).cancelReason).toBe("USER_REQUESTED");
  });

  it("enforces the verdict/error invariants in the database too", async () => {
    const run = await create();
    await expect(tdb.pool.query("UPDATE test_runs SET verdict = 'PASSED' WHERE id = $1", [run.id])).rejects.toThrow(
      /test_runs_verdict_iff_completed/,
    );
  });

  it("throws StaleTransitionError with the actual lifecycle, and NotFound for unknown runs", async () => {
    const run = await create();
    const err = await runs.transition(run.id, "PLANNING", "EXPLORING").catch((e) => e);
    expect(err).toBeInstanceOf(StaleTransitionError);
    expect(err.actual).toBe("QUEUED");
    await expect(runs.transition("run_missing", "QUEUED", "ANALYZING_REQUIREMENT")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("scopes getRequired to the tenant", async () => {
    const run = await create();
    await expect(runs.getRequired(OTHER_TENANT_ID, run.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await runs.getRequired(TEST_TENANT_ID, run.id)).id).toBe(run.id);
  });

  it("lists newest first with a working cursor and no cross-tenant rows", async () => {
    const t = `t_list_${Date.now()}`;
    await tdb.db.execute(sql`INSERT INTO tenants (id, name) VALUES (${t}, 'list')`);
    const created = [];
    for (let i = 0; i < 5; i++) created.push(await create(t));
    await create(OTHER_TENANT_ID);
    const page1 = await runs.list(t, { limit: 2 });
    expect(page1.items.map((r) => r.id)).toEqual([created[4]!.id, created[3]!.id]);
    const page2 = await runs.list(t, { limit: 2, cursor: page1.nextCursor });
    expect(page2.items.map((r) => r.id)).toEqual([created[2]!.id, created[1]!.id]);
    const page3 = await runs.list(t, { limit: 2, cursor: page2.nextCursor });
    expect(page3.items.map((r) => r.id)).toEqual([created[0]!.id]);
    expect(page3.nextCursor).toBeNull();
  });

  it("pages through runs created in the same millisecond without skipping any", async () => {
    const t = `t_burst_${Date.now()}`;
    await tdb.db.execute(sql`INSERT INTO tenants (id, name) VALUES (${t}, 'burst')`);
    const created = await Promise.all(Array.from({ length: 200 }, () => create(t)));
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = await runs.list(t, { limit: 3, cursor });
      for (const r of page.items) seen.add(r.id);
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen.size).toBe(created.length);
  });

  it("finds QUEUED runs older than a cutoff and runs past their deadline", async () => {
    const q = await create();
    expect((await runs.findQueuedSince(new Date(Date.now() + 1000))).map((r) => r.id)).toContain(q.id);
    expect((await runs.findQueuedSince(new Date(Date.now() - 60_000))).map((r) => r.id)).not.toContain(q.id);
    const a = await create();
    await runs.transition(a.id, "QUEUED", "ANALYZING_REQUIREMENT");
    await runs.transition(a.id, "ANALYZING_REQUIREMENT", "PLANNING");
    await runs.markExecutionStarted(a.id, { startedAt: new Date(), deadlineAt: new Date(Date.now() - 5_000) });
    expect((await runs.findPastDeadline(new Date())).map((r) => r.id)).toContain(a.id);
    expect((await runs.findPastDeadline(new Date(Date.now() - 60_000))).map((r) => r.id)).not.toContain(a.id);
  });

  it("marks cancel requests on non-terminal runs only", async () => {
    const run = await create();
    await runs.transition(run.id, "QUEUED", "ANALYZING_REQUIREMENT");
    const marked = await runs.requestCancel(run.id, "USER_REQUESTED");
    expect(marked?.cancelRequestedAt).toBeInstanceOf(Date);
    expect(marked?.lifecycle).toBe("ANALYZING_REQUIREMENT");
    await runs.transition(run.id, "ANALYZING_REQUIREMENT", "CANCELLED", { cancelReason: "USER_REQUESTED" });
    expect(await runs.requestCancel(run.id, "USER_REQUESTED")).toBeNull();
  });

  it("finds stale active runs and counts active runs per tenant", async () => {
    const t = `t_stale_${Date.now()}`;
    await tdb.db.execute(sql`INSERT INTO tenants (id, name) VALUES (${t}, 'stale')`);
    const a = await create(t);
    const b = await create(t);
    await runs.transition(a.id, "QUEUED", "ANALYZING_REQUIREMENT");
    await runs.heartbeat(a.id, new Date(Date.now() - 120_000));
    await runs.transition(b.id, "QUEUED", "ANALYZING_REQUIREMENT");
    await runs.heartbeat(b.id);
    const stale = await runs.findStale(new Date(Date.now() - 60_000));
    expect(stale.map((r) => r.id)).toContain(a.id);
    expect(stale.map((r) => r.id)).not.toContain(b.id);
    expect(await runs.countActive(t)).toBe(2);
    await runs.transition(b.id, "ANALYZING_REQUIREMENT", "ERRORED", { errorCategory: "INTERNAL" });
    expect(await runs.countActive(t)).toBe(1);
  });

  it("finds runs awaiting confirmation longer than a cutoff", async () => {
    const run = await create();
    await runs.transition(run.id, "QUEUED", "ANALYZING_REQUIREMENT");
    await runs.transition(run.id, "ANALYZING_REQUIREMENT", "AWAITING_CONFIRMATION");
    expect((await runs.findAwaitingConfirmationSince(new Date(Date.now() + 1000))).map((r) => r.id)).toContain(run.id);
    expect((await runs.findAwaitingConfirmationSince(new Date(Date.now() - 60_000))).map((r) => r.id)).not.toContain(run.id);
  });
});

describe("SecretRepository", () => {
  it("stores ciphertext and purges it", async () => {
    const run = await create();
    const secrets = new SecretRepository(tdb.db);
    await secrets.insertMany(run.id, [
      { name: "password", ciphertext: Buffer.from("c"), iv: Buffer.alloc(12), authTag: Buffer.alloc(16) },
    ]);
    expect(await secrets.listActive(run.id)).toHaveLength(1);
    expect(await secrets.purge(run.id)).toBe(1);
    expect(await secrets.listActive(run.id)).toHaveLength(0);
    expect(await secrets.purge(run.id)).toBe(0);
    expect(await secrets.listNames(run.id)).toEqual(["password"]);
  });
});

describe("database enums", () => {
  it.each([
    ["run_lifecycle", RunLifecycleSchema.options],
    ["run_verdict", RunVerdictSchema.options],
    ["error_category", ErrorCategorySchema.options],
    ["cancel_reason", CancelReasonSchema.options],
    ["criterion_status", CriterionStatusSchema.options],
    ["artifact_type", ArtifactTypeSchema.options],
    ["artifact_sensitivity", ArtifactSensitivitySchema.options],
  ])("%s matches the contracts", async (typname, expected) => {
    const res = await tdb.pool.query(
      "SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = $1 ORDER BY e.enumsortorder",
      [typname],
    );
    expect(res.rows.map((r) => r.enumlabel)).toEqual([...expected]);
  });
});
