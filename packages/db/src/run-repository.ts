import {
  isTerminalLifecycle,
  type CancelReason,
  type ErrorCategory,
  type RunLifecycle,
  type RunVerdict,
  type StoredTestRunRequest,
  type TestRunSummary,
} from "@platform/contracts";
import { and, count, desc, eq, inArray, lt, notInArray, or, sql } from "drizzle-orm";
import type { Executor } from "./client";
import { NotFoundError, RunInvariantError, StaleTransitionError } from "./errors";
import { newId } from "./ids";
import { testRuns } from "./schema";
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
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateRunInput {
  id?: string;
  tenantId: string;
  targetUrl: string;
  request: StoredTestRunRequest;
  idempotencyKey?: string | null;
  requestHash?: string | null;
}

export interface TransitionPatch {
  verdict?: RunVerdict;
  errorCategory?: ErrorCategory;
  errorMessage?: string;
  cancelReason?: CancelReason;
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

export function toRunSummary(run: TestRun): TestRunSummary {
  return {
    runId: run.id,
    lifecycle: run.lifecycle,
    verdict: run.verdict,
    errorCategory: run.errorCategory,
    cancelReason: run.lifecycle === "CANCELLED" ? run.cancelReason : null,
    targetUrl: run.targetUrl,
    requirementPreview: run.request.requirement.slice(0, 200),
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
  };
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
      })
      .returning();
    return toRun(row!);
  }

  async findById(runId: string): Promise<TestRun | null> {
    const [row] = await this.db.select().from(testRuns).where(eq(testRuns.id, runId));
    return row ? toRun(row) : null;
  }

  /** Worker-side lookup (no tenant scope). */
  async getById(runId: string): Promise<TestRun> {
    const run = await this.findById(runId);
    if (!run) throw new NotFoundError("TestRun", runId);
    return run;
  }

  /** Tenant-scoped; other tenants' runs are indistinguishable from missing ones. */
  async getRequired(tenantId: string, runId: string): Promise<TestRun> {
    const [row] = await this.db
      .select()
      .from(testRuns)
      .where(and(eq(testRuns.id, runId), eq(testRuns.tenantId, tenantId)));
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

  async list(tenantId: string, opts: { limit: number; cursor?: string | null }): Promise<Page<TestRun>> {
    const limit = Math.max(1, Math.min(opts.limit, 100));
    let where = eq(testRuns.tenantId, tenantId);
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

  async heartbeat(runId: string, at: Date = new Date()): Promise<void> {
    await this.db
      .update(testRuns)
      .set({ heartbeatAt: at })
      .where(and(eq(testRuns.id, runId), notInArray(testRuns.lifecycle, [...TERMINAL_LIFECYCLES])));
  }

  async setDeadline(runId: string, deadlineAt: Date): Promise<void> {
    await this.db.update(testRuns).set({ deadlineAt, updatedAt: new Date() }).where(eq(testRuns.id, runId));
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

  async findAwaitingConfirmationSince(before: Date): Promise<TestRun[]> {
    const rows = await this.db
      .select()
      .from(testRuns)
      .where(and(eq(testRuns.lifecycle, "AWAITING_CONFIRMATION"), lt(testRuns.lifecycleChangedAt, before)));
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

  async countActive(tenantId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(testRuns)
      .where(and(eq(testRuns.tenantId, tenantId), notInArray(testRuns.lifecycle, [...TERMINAL_LIFECYCLES])));
    return Number(row?.n ?? 0);
  }
}
