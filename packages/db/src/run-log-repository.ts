import {
  RunLogLevelSchema,
  type RunLifecycle,
  type RunLogLevel,
  type RunLogLine,
  type RunLogPage,
  type RunLogQuery,
  type RunLogSource,
} from "@platform/contracts";
import { and, asc, count, eq, gt, ilike, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import type { Executor } from "./client";
import { newId } from "./ids";
import { runLogs, testRuns } from "./schema";

/** One line to store. The run's tenant is set by the database from the run (trigger), never by the writer. */
export interface NewRunLogLine {
  runId: string;
  time: Date;
  source: RunLogSource;
  level: RunLogLevel;
  stage: RunLifecycle | null;
  component: string;
  message: string;
  fields: Record<string, unknown>;
}

type ListQuery = Omit<RunLogQuery, "limit"> & { limit: number };
type Row = typeof runLogs.$inferSelect;

const LEVELS = RunLogLevelSchema.options;

const encodeCursor = (row: Pick<Row, "time" | "id">) => Buffer.from(`${row.time.toISOString()}|${row.id}`).toString("base64url");

function decodeCursor(cursor: string): { time: Date; id: string } | null {
  const [iso, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  const time = new Date(iso ?? "");
  return id && !Number.isNaN(time.getTime()) ? { time, id } : null;
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** A string Postgres accepts in `text` and `jsonb`: no NUL, no half of a surrogate pair. */
const storableText = (s: string) => s.replace(/\u0000/g, "").replace(LONE_SURROGATE, "\uFFFD");

/**
 * A value Postgres accepts in `jsonb`: strings made storable, BigInts as strings, a value inside itself
 * "[Circular]", anything JSON can't hold dropped as JSON.stringify would.
 */
export function storableJson(value: unknown, ancestors: object[] = []): unknown {
  if (typeof value === "string") return storableText(value);
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return value;
  if (ancestors.includes(value)) return "[Circular]";
  const toJSON = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === "function") return storableJson(toJSON.call(value), [...ancestors, value]);
  const path = [...ancestors, value];
  if (Array.isArray(value)) return value.map((v) => storableJson(v, path));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[storableText(k)] = storableJson(v, path);
  return out;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

function toLine(row: Row): RunLogLine {
  return {
    id: row.id,
    time: row.time.toISOString(),
    source: row.source as RunLogSource,
    level: row.level as RunLogLevel,
    stage: row.stage,
    component: row.component,
    message: row.message,
    fields: (row.fields ?? {}) as Record<string, unknown>,
  };
}

/** Admin run logs (2026-11-25): every source's lines about one run. */
export class RunLogRepository {
  constructor(private readonly db: Executor) {}

  /** Stores the lines whose run exists (others are dropped, not an error). Returns how many were stored. */
  async appendMany(lines: readonly NewRunLogLine[]): Promise<number> {
    if (lines.length === 0) return 0;
    const ids = [...new Set(lines.map((l) => l.runId))];
    const known = new Set(
      (await this.db.select({ id: testRuns.id }).from(testRuns).where(inArray(testRuns.id, ids))).map((r) => r.id),
    );
    const rows = lines
      .filter((l) => known.has(l.runId))
      .map((l) => ({
        id: newId("log"),
        ...l,
        component: storableText(l.component),
        message: storableText(l.message),
        fields: storableJson(l.fields) as Record<string, unknown>,
      }));
    if (rows.length === 0) return 0;
    await this.db.insert(runLogs).values(rows);
    return rows.length;
  }

  /** One page of a run's lines in `(time, id)` order; empty for a run outside the tenant. */
  async list(tenantId: string, runId: string, query: ListQuery): Promise<RunLogPage> {
    const where: SQL[] = [eq(runLogs.runId, runId), eq(runLogs.tenantId, tenantId)];
    if (query.source?.length) where.push(inArray(runLogs.source, query.source));
    if (query.minLevel) where.push(inArray(runLogs.level, LEVELS.slice(LEVELS.indexOf(query.minLevel))));
    if (query.stage) where.push(eq(runLogs.stage, query.stage));
    if (query.q) where.push(ilike(runLogs.message, `%${escapeLike(query.q)}%`));
    const cursor = query.after ? decodeCursor(query.after) : null;
    if (cursor) {
      where.push(or(gt(runLogs.time, cursor.time), and(eq(runLogs.time, cursor.time), gt(runLogs.id, cursor.id)))!);
    }
    const rows = await this.db
      .select()
      .from(runLogs)
      .where(and(...where))
      .orderBy(asc(runLogs.time), asc(runLogs.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      lines: page.map(toLine),
      nextCursor: rows.length > query.limit && last ? encodeCursor(last) : null,
      lastCursor: last ? encodeCursor(last) : null,
    };
  }

  async count(runId: string): Promise<number> {
    const [row] = await this.db.select({ n: count() }).from(runLogs).where(eq(runLogs.runId, runId));
    return row?.n ?? 0;
  }

  /** How many frontend-error lines one user's browser has sent for the run (the client-logs budget). */
  async countWebAppLines(runId: string, userId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(runLogs)
      .where(and(eq(runLogs.runId, runId), eq(runLogs.source, "web_app"), sql`${runLogs.fields}->>'userId' = ${userId}`));
    return row?.n ?? 0;
  }

  /** Retention: deletes up to `limit` lines older than `cutoff`; returns how many. */
  async deleteOlderThan(cutoff: Date, limit: number): Promise<number> {
    const batch = this.db.select({ id: runLogs.id }).from(runLogs).where(lt(runLogs.time, cutoff)).limit(limit);
    const deleted = await this.db.delete(runLogs).where(inArray(runLogs.id, batch)).returning({ id: runLogs.id });
    return deleted.length;
  }
}
