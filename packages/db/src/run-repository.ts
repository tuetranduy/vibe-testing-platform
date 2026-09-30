import {
  MAX_TEST_DATA_ENTRIES,
  destructiveActionsAllowed,
  isTerminalLifecycle,
  type CancelReason,
  type ErrorCategory,
  type RunLifecycle,
  type RunVerdict,
  type StoredTestRunRequest,
  type TestDataValue,
  type TestRunSummary,
} from "@platform/contracts";
import { and, count, desc, eq, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import type { Executor } from "./client";
import { NotFoundError, RunInvariantError, StaleTransitionError } from "./errors";
import { comparisonKeyOf, newId } from "./ids";
import { suiteRuns, testRuns } from "./schema";
import { ACTIVE_LIFECYCLES, TERMINAL_LIFECYCLES, assertTransition } from "./state-machine";

export interface TestRun {
  id: string;
  tenantId: string;
  targetUrl: string;
  request: StoredTestRunRequest;
  lifecycle: RunLifecycle;
  lifecycleChangedAt: Date;
  verdict: RunVerdict | null;
  errorCategory: ErrorCategory | null;
  errorMessage: string | null;
  cancelRequestedAt: Date | null;
  cancelReason: CancelReason | null;
  heartbeatAt: Date | null;
  deadlineAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  idempotencyKey: string | null;
  requestHash: string | null;
  ownerUserId: string | null;
  /** The suite run this run is part of (V1.2 F1). */
  suiteRunId: string | null;
  /** Shared by runs of the same test (V1.2 F2): comparisonKeyOf, or the rerun source's. */
  comparisonKey: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Which runs a caller may see (V1.1 F1): every run of the tenant, or only those one user owns. Other
 * runs are indistinguishable from missing ones.
 */
export interface RunScope {
  tenantId: string;
  /** Set: only this user's runs. */
  ownerUserId?: string | null;
}

export interface CreateRunInput {
  id?: string;
  tenantId: string;
  targetUrl: string;
  request: StoredTestRunRequest;
  idempotencyKey?: string | null;
  requestHash?: string | null;
  ownerUserId?: string | null;
  suiteRunId?: string | null;
  /** A rerun passes its source's; otherwise derived from the target URL and requirement. */
  comparisonKey?: string | null;
}

export interface TransitionPatch {
  verdict?: RunVerdict;
  errorCategory?: ErrorCategory;
  errorMessage?: string;
  cancelReason?: CancelReason;
  cancelRequestedAt?: Date;
  heartbeatAt?: Date | null;
  deadlineAt?: Date | null;
  startedAt?: Date;
  finishedAt?: Date;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

type Row = typeof testRuns.$inferSelect;

function toRun(row: Row): TestRun {
  const { requestJson, nextEventSequence: _seq, ...rest } = row;
  return { ...rest, request: requestJson as StoredTestRunRequest };
}

/**
 * `modelLabel` names the run's model for display: the API passes the model catalog's labels (@platform/llm,
 * which db does not depend on); by default, the model id.
 */
export function toRunSummary(
  run: TestRun,
  modelLabel: (model: string) => string = (model) => model,
  ownerName: (userId: string) => string | null = () => null,
): TestRunSummary {
  const llm = run.request.llm;
  return {
    runId: run.id,
    lifecycle: run.lifecycle,
    verdict: run.verdict,
    errorCategory: run.errorCategory,
    cancelReason: run.lifecycle === "CANCELLED" ? run.cancelReason : null,
    targetUrl: run.targetUrl,
    environment: run.request.environment,
    allowDestructiveActions: destructiveActionsAllowed(run.request),
    requirementPreview: run.request.requirement.slice(0, 200),
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    llm: llm ? { provider: llm.provider, model: llm.model, label: modelLabel(llm.model), reasoning: llm.reasoning } : null,
    owner: run.ownerUserId ? { id: run.ownerUserId, name: ownerName(run.ownerUserId) ?? "Former user" } : null,
    kind: run.request.rerunOf ? "rerun" : "discovery",
    sourceRunId: run.request.rerunOf ?? null,
    secretNames: run.request.secretNames,
    suiteRunId: run.suiteRunId,
  };
}

function scopeWhere(scope: string | RunScope) {
  const s = typeof scope === "string" ? { tenantId: scope } : scope;
  return s.ownerUserId ? and(eq(testRuns.tenantId, s.tenantId), eq(testRuns.ownerUserId, s.ownerUserId))! : eq(testRuns.tenantId, s.tenantId);
}

function encodeCursor(run: TestRun): string {
  return Buffer.from(JSON.stringify([run.createdAt.toISOString(), run.id])).toString("base64url");
}

function decodeCursor(cursor: string): [Date, string] | null {
  try {
    const [iso, id] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as [string, string];
    const d = new Date(iso);
    if (Number.isNaN(d.getTime()) || typeof id !== "string") return null;
    return [d, id];
  } catch {
    return null;
  }
}

export class InvalidCursorError extends Error {
  constructor() {
    super("Invalid cursor");
    this.name = "InvalidCursorError";
  }
}

export class RunRepository {
  constructor(private readonly db: Executor) {}

  async create(input: CreateRunInput): Promise<TestRun> {
    const [row] = await this.db
      .insert(testRuns)
      .values({
        id: input.id ?? newId("run"),
        tenantId: input.tenantId,
        targetUrl: input.targetUrl,
        requestJson: input.request,
        idempotencyKey: input.idempotencyKey ?? null,
        requestHash: input.requestHash ?? null,
        ownerUserId: input.ownerUserId ?? null,
        suiteRunId: input.suiteRunId ?? null,
        comparisonKey:
          input.comparisonKey !== undefined
            ? input.comparisonKey
            : input.request.rerunOf
              ? null
              : comparisonKeyOf(input.targetUrl, input.request.requirement),
        // Millisecond precision (not Postgres' microseconds) so list cursors round-trip exactly.
        createdAt: new Date(),
      })
      .returning();
    return toRun(row!);
  }

  /** Frees an Idempotency-Key so a retry can create a new run (used when enqueueing failed). */
  async releaseIdempotencyKey(runId: string): Promise<void> {
    await this.db.update(testRuns).set({ idempotencyKey: null, updatedAt: new Date() }).where(eq(testRuns.id, runId));
  }

  /** Locks the tenant row for the rest of the transaction (serializes per-tenant admission checks). */
  async lockTenant(tenantId: string): Promise<void> {
    await this.db.execute(sql`SELECT id FROM tenants WHERE id = ${tenantId} FOR UPDATE`);
  }

  async findById(runId: string): Promise<TestRun | null> {
    const [row] = await this.db.select().from(testRuns).where(eq(testRuns.id, runId));
    return row ? toRun(row) : null;
  }

  /** Runs of the tenant by id (missing ones are left out). */
  async findByIds(tenantId: string, runIds: readonly string[]): Promise<Map<string, TestRun>> {
    if (runIds.length === 0) return new Map();
    const rows = await this.db
      .select()
      .from(testRuns)
      .where(and(eq(testRuns.tenantId, tenantId), inArray(testRuns.id, [...new Set(runIds)])));
    return new Map(rows.map((r) => [r.id, toRun(r)]));
  }

  /** Worker-side lookup (no tenant scope). */
  async getById(runId: string): Promise<TestRun> {
    const run = await this.findById(runId);
    if (!run) throw new NotFoundError("TestRun", runId);
    return run;
  }

  /**
   * Tenant-scoped (a string) or caller-scoped (a RunScope with an owner); runs outside the scope are
   * indistinguishable from missing ones.
   */
  async getRequired(scope: string | RunScope, runId: string): Promise<TestRun> {
    const [row] = await this.db
      .select()
      .from(testRuns)
      .where(and(eq(testRuns.id, runId), scopeWhere(scope)));
    if (!row) throw new NotFoundError("TestRun", runId);
    return toRun(row);
  }

  async findByIdempotencyKey(tenantId: string, key: string): Promise<TestRun | null> {
    const [row] = await this.db
      .select()
      .from(testRuns)
      .where(and(eq(testRuns.tenantId, tenantId), eq(testRuns.idempotencyKey, key)));
    return row ? toRun(row) : null;
  }

  async list(scope: string | RunScope, opts: { limit: number; cursor?: string | null }): Promise<Page<TestRun>> {
    const limit = Math.max(1, Math.min(opts.limit, 100));
    let where = scopeWhere(scope);
    if (opts.cursor) {
      const c = decodeCursor(opts.cursor);
      if (!c) throw new InvalidCursorError();
      const [at, id] = c;
      where = and(
        where,
        or(lt(testRuns.createdAt, at), and(eq(testRuns.createdAt, at), lt(testRuns.id, id))),
      )!;
    }
    const rows = await this.db
      .select()
      .from(testRuns)
      .where(where)
      .orderBy(desc(testRuns.createdAt), desc(testRuns.id))
      .limit(limit + 1);
    const items = rows.slice(0, limit).map(toRun);
    const nextCursor = rows.length > limit ? encodeCursor(items[items.length - 1]!) : null;
    return { items, nextCursor };
  }

  /**
   * Compare-and-set lifecycle change. The only code path allowed to write `lifecycle`.
   * Throws IllegalRunTransitionError, RunInvariantError, NotFoundError, or StaleTransitionError.
   */
  async transition(runId: string, from: RunLifecycle, to: RunLifecycle, patch: TransitionPatch = {}): Promise<TestRun> {
    assertTransition(from, to);
    if (to === "COMPLETED" && !patch.verdict) throw new RunInvariantError("COMPLETED requires a verdict");
    if (to !== "COMPLETED" && patch.verdict) throw new RunInvariantError("verdict is only set when COMPLETED");
    if (to === "ERRORED" && !patch.errorCategory) throw new RunInvariantError("ERRORED requires an errorCategory");
    if (to !== "ERRORED" && patch.errorCategory) throw new RunInvariantError("errorCategory is only set when ERRORED");
    if (to === "CANCELLED" && !patch.cancelReason) throw new RunInvariantError("CANCELLED requires a cancelReason");

    const now = new Date();
    const terminal = isTerminalLifecycle(to);
    const [row] = await this.db
      .update(testRuns)
      .set({
        ...patch,
        lifecycle: to,
        lifecycleChangedAt: now,
        updatedAt: now,
        ...(terminal ? { finishedAt: patch.finishedAt ?? now, heartbeatAt: null } : {}),
      })
      .where(and(eq(testRuns.id, runId), eq(testRuns.lifecycle, from)))
      .returning();
    if (row) return toRun(row);

    const current = await this.findById(runId);
    if (!current) throw new NotFoundError("TestRun", runId);
    throw new StaleTransitionError(runId, from, current.lifecycle);
  }

  /**
   * Replaces the stored request's requirement and nothing else: a selected suggestion's text, or its
   * value-redacted form (the worker, before the model sees it). Everything else reads it from there.
   */
  async setRequirement(runId: string, requirement: string): Promise<void> {
    await this.db
      .update(testRuns)
      .set({
        requestJson: sql`jsonb_set(${testRuns.requestJson}, '{requirement}', to_jsonb(${requirement}::text))`,
        // The first text the run gets names its test (the chosen suggestion); a later redaction never changes it.
        comparisonKey: sql`coalesce(${testRuns.comparisonKey}, ${comparisonKeyOf((await this.getById(runId)).targetUrl, requirement)})`,
        updatedAt: new Date(),
      })
      .where(eq(testRuns.id, runId));
  }

  /**
   * Adds test data to a run that has not started executing (V1.3: suggested values accepted at confirmation,
   * or applied automatically): `values` are merged over the run's own (a key it has is replaced), under the
   * run's row lock. More than MAX_TEST_DATA_ENTRIES keys in all → RunInvariantError, and nothing is written.
   * Returns the merged test data.
   */
  async mergeTestData(runId: string, values: Record<string, TestDataValue>): Promise<Record<string, TestDataValue>> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.select({ requestJson: testRuns.requestJson }).from(testRuns).where(eq(testRuns.id, runId)).for("update");
      if (!row) throw new NotFoundError("TestRun", runId);
      const current = (row.requestJson as StoredTestRunRequest).testData ?? {};
      const merged = { ...current, ...values };
      if (Object.keys(merged).length > MAX_TEST_DATA_ENTRIES) {
        throw new RunInvariantError(`A run has at most ${MAX_TEST_DATA_ENTRIES} test data entries`);
      }
      await tx
        .update(testRuns)
        .set({ requestJson: sql`jsonb_set(${testRuns.requestJson}, '{testData}', ${JSON.stringify(merged)}::jsonb)`, updatedAt: new Date() })
        .where(eq(testRuns.id, runId));
      return merged;
    });
  }

  /**
   * The run `run` is compared with by default (V1.2 F2): the latest COMPLETED run of the same test (comparison key)
   * created before it, within the caller's scope; null when there is none.
   */
  async findPreviousComparable(scope: RunScope, run: TestRun): Promise<TestRun | null> {
    if (!run.comparisonKey) return null;
    const [row] = await this.db
      .select()
      .from(testRuns)
      .where(
        and(
          scopeWhere(scope),
          eq(testRuns.comparisonKey, run.comparisonKey),
          eq(testRuns.lifecycle, "COMPLETED"),
          or(lt(testRuns.createdAt, run.createdAt), and(eq(testRuns.createdAt, run.createdAt), lt(testRuns.id, run.id))),
        ),
      )
      .orderBy(desc(testRuns.createdAt), desc(testRuns.id))
      .limit(1);
    return row ? toRun(row) : null;
  }

  /** COMPLETED runs of the same test other than `run`, newest first (the baselines a user may choose). */
  async listComparable(scope: RunScope, run: TestRun, limit = 20): Promise<TestRun[]> {
    if (!run.comparisonKey) return [];
    const rows = await this.db
      .select()
      .from(testRuns)
      .where(
        and(
          scopeWhere(scope),
          eq(testRuns.comparisonKey, run.comparisonKey),
          eq(testRuns.lifecycle, "COMPLETED"),
          sql`${testRuns.id} <> ${run.id}`,
        ),
      )
      .orderBy(desc(testRuns.createdAt), desc(testRuns.id))
      .limit(Math.max(1, Math.min(limit, 100)));
    return rows.map(toRun);
  }

  /** Marks a cancel request on a non-terminal run. Returns null if the run is already terminal. */
  async requestCancel(runId: string, reason: CancelReason): Promise<TestRun | null> {
    const now = new Date();
    const [row] = await this.db
      .update(testRuns)
      .set({
        cancelRequestedAt: sql`coalesce(${testRuns.cancelRequestedAt}, ${now.toISOString()}::timestamptz)`,
        cancelReason: sql`coalesce(${testRuns.cancelReason}, ${reason}::cancel_reason)`,
        updatedAt: now,
      })
      .where(and(eq(testRuns.id, runId), notInArray(testRuns.lifecycle, [...TERMINAL_LIFECYCLES])))
      .returning();
    if (row) return toRun(row);
    const current = await this.findById(runId);
    if (!current) throw new NotFoundError("TestRun", runId);
    return null;
  }

  /** Only active runs beat; QUEUED / AWAITING_CONFIRMATION / terminal runs are left untouched. */
  async heartbeat(runId: string, at: Date = new Date()): Promise<void> {
    await this.db
      .update(testRuns)
      .set({ heartbeatAt: at })
      .where(and(eq(testRuns.id, runId), inArray(testRuns.lifecycle, [...ACTIVE_LIFECYCLES])));
  }

  /** Records the hard deadline and start time when execution begins (the clock starts at PLANNING). */
  async markExecutionStarted(runId: string, at: { deadlineAt: Date; startedAt: Date }): Promise<void> {
    await this.db
      .update(testRuns)
      .set({ deadlineAt: at.deadlineAt, startedAt: at.startedAt, heartbeatAt: at.startedAt, updatedAt: new Date() })
      .where(eq(testRuns.id, runId));
  }

  /** Active runs whose last heartbeat (or lifecycle change, if never beat) is older than `olderThan`. */
  async findStale(olderThan: Date): Promise<TestRun[]> {
    const rows = await this.db
      .select()
      .from(testRuns)
      .where(
        and(
          inArray(testRuns.lifecycle, [...ACTIVE_LIFECYCLES]),
          lt(sql`coalesce(${testRuns.heartbeatAt}, ${testRuns.lifecycleChangedAt})`, olderThan),
        ),
      );
    return rows.map(toRun);
  }

  /** QUEUED runs created before `before` (candidates for "never picked up"). */
  async findQueuedSince(before: Date): Promise<TestRun[]> {
    const rows = await this.db
      .select()
      .from(testRuns)
      .where(and(eq(testRuns.lifecycle, "QUEUED"), lt(testRuns.createdAt, before)));
    return rows.map(toRun);
  }

  /** Active runs whose hard deadline passed before `before`. */
  async findPastDeadline(before: Date): Promise<TestRun[]> {
    const rows = await this.db
      .select()
      .from(testRuns)
      .where(and(inArray(testRuns.lifecycle, [...ACTIVE_LIFECYCLES]), lt(testRuns.deadlineAt, before)));
    return rows.map(toRun);
  }

  async findAwaitingConfirmationSince(before: Date): Promise<TestRun[]> {
    const rows = await this.db
      .select()
      .from(testRuns)
      .where(and(eq(testRuns.lifecycle, "AWAITING_CONFIRMATION"), lt(testRuns.lifecycleChangedAt, before)));
    return rows.map(toRun);
  }

  /** Runs waiting for the user to choose a suggested test since before `before`. */
  async findAwaitingSelectionSince(before: Date): Promise<TestRun[]> {
    const rows = await this.db
      .select()
      .from(testRuns)
      .where(and(eq(testRuns.lifecycle, "AWAITING_SELECTION"), lt(testRuns.lifecycleChangedAt, before)));
    return rows.map(toRun);
  }

  async findTerminal(opts: { limit: number }): Promise<TestRun[]> {
    const rows = await this.db
      .select()
      .from(testRuns)
      .where(inArray(testRuns.lifecycle, [...TERMINAL_LIFECYCLES]))
      .limit(opts.limit);
    return rows.map(toRun);
  }

  /**
   * What the admission cap counts: active runs started on their own, plus running suite runs — one each,
   * whatever their size (V1.2 F1); a suite run's children don't count.
   */
  async countActive(tenantId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(testRuns)
      .where(
        and(eq(testRuns.tenantId, tenantId), notInArray(testRuns.lifecycle, [...TERMINAL_LIFECYCLES]), isNull(testRuns.suiteRunId)),
      );
    const [suites] = await this.db
      .select({ n: count() })
      .from(suiteRuns)
      .where(and(eq(suiteRuns.tenantId, tenantId), eq(suiteRuns.status, "RUNNING")));
    return Number(row?.n ?? 0) + Number(suites?.n ?? 0);
  }
}
