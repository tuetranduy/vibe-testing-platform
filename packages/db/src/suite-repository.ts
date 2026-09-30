import { MAX_SUITE_ENTRIES, TERMINAL_LIFECYCLES, suiteVerdict, type RunVerdict, type SuiteRunStatus, type SuiteRunTrigger } from "@platform/contracts";
import { and, asc, count, desc, eq, inArray, max, notInArray, sql } from "drizzle-orm";
import type { Executor } from "./client";
import { newId } from "./ids";
import type { RunScope, TestRun } from "./run-repository";
import { RunRepository } from "./run-repository";
import { suiteRuns, testRuns, testSuiteEntries, testSuites } from "./schema";
import { NameTakenError } from "./test-data-set-repository";
import { isUniqueViolation } from "./user-repository";

export interface SuiteRow {
  id: string;
  tenantId: string;
  name: string;
  description: string;
  credentialProfileId: string | null;
  ownerUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SuiteEntryRow {
  suiteId: string;
  sourceRunId: string;
  position: number;
  confirmDestructive: boolean;
  addedBy: string | null;
  addedAt: Date;
}

export interface SuiteRunRow {
  id: string;
  tenantId: string;
  suiteId: string;
  suiteName: string;
  trigger: SuiteRunTrigger;
  scheduleId: string | null;
  ownerUserId: string | null;
  context: Record<string, unknown>;
  status: SuiteRunStatus;
  verdict: RunVerdict | null;
  idempotencyKey: string | null;
  requestHash: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

/** Thrown when a suite already has MAX_SUITE_ENTRIES entries. */
export class SuiteFullError extends Error {
  constructor() {
    super(`A suite holds at most ${MAX_SUITE_ENTRIES} tests`);
    this.name = "SuiteFullError";
  }
}

/** Thrown when the run is already in the suite. */
export class EntryExistsError extends Error {
  constructor() {
    super("This test is already in the suite");
    this.name = "EntryExistsError";
  }
}

/** The same scope as runs (V1.1 F1): a member sees only what they own. */
function suiteWhere(scope: RunScope) {
  return scope.ownerUserId
    ? and(eq(testSuites.tenantId, scope.tenantId), eq(testSuites.ownerUserId, scope.ownerUserId))!
    : eq(testSuites.tenantId, scope.tenantId);
}

function suiteRunWhere(scope: RunScope) {
  return scope.ownerUserId
    ? and(eq(suiteRuns.tenantId, scope.tenantId), eq(suiteRuns.ownerUserId, scope.ownerUserId))!
    : eq(suiteRuns.tenantId, scope.tenantId);
}

const toSuiteRun = (r: typeof suiteRuns.$inferSelect): SuiteRunRow => ({ ...r, context: (r.context ?? {}) as Record<string, unknown> });

/** Suites and their entries (V1.2 F1). */
export class SuiteRepository {
  constructor(private readonly db: Executor) {}

  async list(scope: RunScope): Promise<SuiteRow[]> {
    return this.db.select().from(testSuites).where(suiteWhere(scope)).orderBy(sql`lower(${testSuites.name})`);
  }

  async find(scope: RunScope, id: string): Promise<SuiteRow | null> {
    const [row] = await this.db
      .select()
      .from(testSuites)
      .where(and(suiteWhere(scope), eq(testSuites.id, id)));
    return row ?? null;
  }

  /** Case-insensitive, exact. */
  async findByName(scope: RunScope, name: string): Promise<SuiteRow | null> {
    const [row] = await this.db
      .select()
      .from(testSuites)
      .where(and(suiteWhere(scope), sql`lower(${testSuites.name}) = ${name.trim().toLowerCase()}`));
    return row ?? null;
  }

  async create(input: {
    tenantId: string;
    name: string;
    description: string;
    credentialProfileId: string | null;
    ownerUserId: string | null;
  }): Promise<SuiteRow> {
    try {
      const [row] = await this.db
        .insert(testSuites)
        .values({ id: newId("ste"), ...input })
        .returning();
      return row!;
    } catch (err) {
      if (isUniqueViolation(err)) throw new NameTakenError("suite");
      throw err;
    }
  }

  async update(
    scope: RunScope,
    id: string,
    input: { name: string; description: string; credentialProfileId: string | null },
  ): Promise<SuiteRow | null> {
    try {
      const [row] = await this.db
        .update(testSuites)
        .set({ ...input, updatedAt: new Date() })
        .where(and(suiteWhere(scope), eq(testSuites.id, id)))
        .returning();
      return row ?? null;
    } catch (err) {
      if (isUniqueViolation(err)) throw new NameTakenError("suite");
      throw err;
    }
  }

  async remove(scope: RunScope, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(testSuites)
      .where(and(suiteWhere(scope), eq(testSuites.id, id)))
      .returning({ id: testSuites.id });
    return rows.length > 0;
  }

  async entryCounts(suiteIds: readonly string[]): Promise<Map<string, number>> {
    if (suiteIds.length === 0) return new Map();
    const rows = await this.db
      .select({ suiteId: testSuiteEntries.suiteId, n: count() })
      .from(testSuiteEntries)
      .where(inArray(testSuiteEntries.suiteId, [...suiteIds]))
      .groupBy(testSuiteEntries.suiteId);
    return new Map(rows.map((r) => [r.suiteId, Number(r.n)]));
  }

  /** In run order. */
  async entries(suiteId: string): Promise<SuiteEntryRow[]> {
    return this.db
      .select()
      .from(testSuiteEntries)
      .where(eq(testSuiteEntries.suiteId, suiteId))
      .orderBy(asc(testSuiteEntries.position), asc(testSuiteEntries.addedAt));
  }

  /** Every entry of these suites, grouped by suite, in run order. */
  async entriesOf(suiteIds: readonly string[]): Promise<Map<string, SuiteEntryRow[]>> {
    const out = new Map(suiteIds.map((id) => [id, [] as SuiteEntryRow[]]));
    if (suiteIds.length === 0) return out;
    const rows = await this.db
      .select()
      .from(testSuiteEntries)
      .where(inArray(testSuiteEntries.suiteId, [...suiteIds]))
      .orderBy(asc(testSuiteEntries.position), asc(testSuiteEntries.addedAt));
    for (const r of rows) out.get(r.suiteId)?.push(r);
    return out;
  }

  /**
   * Appends a test at the end. The suite row is locked so concurrent adds count and number entries one at a
   * time. Throws SuiteFullError, EntryExistsError.
   */
  async addEntry(suiteId: string, input: { sourceRunId: string; confirmDestructive: boolean; addedBy: string | null }): Promise<SuiteEntryRow> {
    const add = async (tx: Executor) => {
      await tx.execute(sql`SELECT id FROM test_suites WHERE id = ${suiteId} FOR UPDATE`);
      const [stats] = await tx
        .select({ n: count(), last: max(testSuiteEntries.position) })
        .from(testSuiteEntries)
        .where(eq(testSuiteEntries.suiteId, suiteId));
      if (Number(stats?.n ?? 0) >= MAX_SUITE_ENTRIES) throw new SuiteFullError();
      try {
        const [row] = await tx
          .insert(testSuiteEntries)
          .values({ suiteId, ...input, position: (stats?.last ?? 0) + 1 })
          .returning();
        await tx.update(testSuites).set({ updatedAt: new Date() }).where(eq(testSuites.id, suiteId));
        return row!;
      } catch (err) {
        if (isUniqueViolation(err)) throw new EntryExistsError();
        throw err;
      }
    };
    return this.db.transaction(add);
  }

  async removeEntry(suiteId: string, sourceRunId: string): Promise<boolean> {
    const rows = await this.db
      .delete(testSuiteEntries)
      .where(and(eq(testSuiteEntries.suiteId, suiteId), eq(testSuiteEntries.sourceRunId, sourceRunId)))
      .returning({ id: testSuiteEntries.sourceRunId });
    if (rows.length > 0) await this.db.update(testSuites).set({ updatedAt: new Date() }).where(eq(testSuites.id, suiteId));
    return rows.length > 0;
  }

  /** `sourceRunIds` must name every entry exactly once; false otherwise (nothing changes). */
  async reorder(suiteId: string, sourceRunIds: readonly string[]): Promise<boolean> {
    const run = async (tx: Executor) => {
      await tx.execute(sql`SELECT id FROM test_suites WHERE id = ${suiteId} FOR UPDATE`);
      const current = (await new SuiteRepository(tx).entries(suiteId)).map((e) => e.sourceRunId);
      const wanted = new Set(sourceRunIds);
      if (wanted.size !== sourceRunIds.length || wanted.size !== current.length || current.some((id) => !wanted.has(id))) return false;
      for (const [i, id] of sourceRunIds.entries()) {
        await tx
          .update(testSuiteEntries)
          .set({ position: i + 1 })
          .where(and(eq(testSuiteEntries.suiteId, suiteId), eq(testSuiteEntries.sourceRunId, id)));
      }
      await tx.update(testSuites).set({ updatedAt: new Date() }).where(eq(testSuites.id, suiteId));
      return true;
    };
    return this.db.transaction(run);
  }
}

/** Suite runs (V1.2 F1): one per run of a suite; its children are test runs with `suite_run_id` set. */
export class SuiteRunRepository {
  constructor(private readonly db: Executor) {}

  async create(input: {
    id?: string;
    tenantId: string;
    suiteId: string;
    suiteName: string;
    trigger: SuiteRunTrigger;
    scheduleId?: string | null;
    ownerUserId: string | null;
    context?: Record<string, unknown>;
    idempotencyKey?: string | null;
    requestHash?: string | null;
  }): Promise<SuiteRunRow> {
    const [row] = await this.db
      .insert(suiteRuns)
      .values({
        id: input.id ?? newId("srn"),
        tenantId: input.tenantId,
        suiteId: input.suiteId,
        suiteName: input.suiteName,
        trigger: input.trigger,
        scheduleId: input.scheduleId ?? null,
        ownerUserId: input.ownerUserId,
        context: input.context ?? {},
        idempotencyKey: input.idempotencyKey ?? null,
        requestHash: input.requestHash ?? null,
        createdAt: new Date(),
      })
      .returning();
    return toSuiteRun(row!);
  }

  async find(scope: RunScope, id: string): Promise<SuiteRunRow | null> {
    const [row] = await this.db
      .select()
      .from(suiteRuns)
      .where(and(suiteRunWhere(scope), eq(suiteRuns.id, id)));
    return row ? toSuiteRun(row) : null;
  }

  async findById(id: string): Promise<SuiteRunRow | null> {
    const [row] = await this.db.select().from(suiteRuns).where(eq(suiteRuns.id, id));
    return row ? toSuiteRun(row) : null;
  }

  async findByIdempotencyKey(tenantId: string, key: string): Promise<SuiteRunRow | null> {
    const [row] = await this.db
      .select()
      .from(suiteRuns)
      .where(and(eq(suiteRuns.tenantId, tenantId), eq(suiteRuns.idempotencyKey, key)));
    return row ? toSuiteRun(row) : null;
  }

  /** Newest first. */
  async listForSuite(scope: RunScope, suiteId: string, limit: number): Promise<SuiteRunRow[]> {
    const rows = await this.db
      .select()
      .from(suiteRuns)
      .where(and(suiteRunWhere(scope), eq(suiteRuns.suiteId, suiteId)))
      .orderBy(desc(suiteRuns.createdAt), desc(suiteRuns.id))
      .limit(Math.max(1, Math.min(limit, 100)));
    return rows.map(toSuiteRun);
  }

  /** Each suite's newest run (any owner: the suite's viewer may see its last result). */
  async latestFor(tenantId: string, suiteIds: readonly string[]): Promise<Map<string, SuiteRunRow>> {
    if (suiteIds.length === 0) return new Map();
    const rows = await this.db
      .selectDistinctOn([suiteRuns.suiteId])
      .from(suiteRuns)
      .where(and(eq(suiteRuns.tenantId, tenantId), inArray(suiteRuns.suiteId, [...suiteIds])))
      .orderBy(suiteRuns.suiteId, desc(suiteRuns.createdAt), desc(suiteRuns.id));
    return new Map(rows.map((r) => [r.suiteId, toSuiteRun(r)]));
  }

  /** In the order they were created (the suite's entry order). */
  async children(suiteRunId: string): Promise<TestRun[]> {
    const ids = await this.db
      .select({ id: testRuns.id })
      .from(testRuns)
      .where(eq(testRuns.suiteRunId, suiteRunId))
      .orderBy(asc(testRuns.createdAt), asc(testRuns.id));
    const runs = new RunRepository(this.db);
    return Promise.all(ids.map((r) => runs.getById(r.id)));
  }

  /** The newest child of this suite's runs for each source run (the entry's last result). */
  async lastResultsBySource(tenantId: string, suiteId: string): Promise<Map<string, TestRun>> {
    const source = sql<string>`${testRuns.requestJson}->>'rerunOf'`;
    const rows = await this.db
      .selectDistinctOn([source], { id: testRuns.id, source })
      .from(testRuns)
      .innerJoin(suiteRuns, eq(suiteRuns.id, testRuns.suiteRunId))
      .where(and(eq(suiteRuns.tenantId, tenantId), eq(suiteRuns.suiteId, suiteId)))
      .orderBy(source, desc(testRuns.createdAt), desc(testRuns.id));
    const runs = new RunRepository(this.db);
    const out = new Map<string, TestRun>();
    for (const r of rows) out.set(r.source, await runs.getById(r.id));
    return out;
  }

  /**
   * Completes the suite run once every child is terminal, with the verdict of suiteVerdict. Idempotent and safe
   * to call from anywhere (the worker when a child ends, the reaper's sweep, a read): a finished child never
   * becomes active again, so a verdict computed while all were terminal is final, and the update only applies
   * to a RUNNING row that still has no active child. Returns the row when this call settled it.
   */
  async settle(suiteRunId: string): Promise<SuiteRunRow | null> {
    const children = await this.db
      .select({ lifecycle: testRuns.lifecycle, verdict: testRuns.verdict })
      .from(testRuns)
      .where(eq(testRuns.suiteRunId, suiteRunId));
    if (children.length === 0) return null;
    const verdict = suiteVerdict(children);
    if (!verdict) return null;
    const [row] = await this.db
      .update(suiteRuns)
      .set({ status: "COMPLETED", verdict, finishedAt: new Date() })
      .where(
        and(
          eq(suiteRuns.id, suiteRunId),
          eq(suiteRuns.status, "RUNNING"),
          sql`NOT EXISTS (SELECT 1 FROM ${testRuns} WHERE ${testRuns.suiteRunId} = ${suiteRunId} AND ${notInArray(testRuns.lifecycle, [...TERMINAL_LIFECYCLES])})`,
        ),
      )
      .returning();
    return row ? toSuiteRun(row) : null;
  }

  /** RUNNING suite runs created before `before` (the reaper settles any whose children have all finished). */
  async findRunningSince(before: Date, limit = 500): Promise<SuiteRunRow[]> {
    const rows = await this.db
      .select()
      .from(suiteRuns)
      .where(and(eq(suiteRuns.status, "RUNNING"), sql`${suiteRuns.createdAt} < ${before.toISOString()}::timestamptz`))
      .orderBy(asc(suiteRuns.createdAt))
      .limit(limit);
    return rows.map(toSuiteRun);
  }

  /** Suite runs still running in the tenant: each takes one active-run slot. */
  async countRunning(tenantId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(suiteRuns)
      .where(and(eq(suiteRuns.tenantId, tenantId), eq(suiteRuns.status, "RUNNING")));
    return Number(row?.n ?? 0);
  }
}
