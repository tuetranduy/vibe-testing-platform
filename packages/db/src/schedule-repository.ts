import type { ScheduleOutcome } from "@platform/contracts";
import { and, asc, count, eq } from "drizzle-orm";
import type { Executor } from "./client";
import { newId } from "./ids";
import { suiteSchedules } from "./schema";

export interface ScheduleRow {
  id: string;
  tenantId: string;
  suiteId: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  createdBy: string | null;
  lastFiredAt: Date | null;
  lastOutcome: ScheduleOutcome | null;
  lastError: string | null;
  lastSuiteRunId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const toRow = (r: typeof suiteSchedules.$inferSelect): ScheduleRow => ({ ...r, lastOutcome: r.lastOutcome as ScheduleOutcome | null });

/** Suite schedules (V1.2 F3). */
export class ScheduleRepository {
  constructor(private readonly db: Executor) {}

  async listForSuite(suiteId: string): Promise<ScheduleRow[]> {
    const rows = await this.db.select().from(suiteSchedules).where(eq(suiteSchedules.suiteId, suiteId)).orderBy(asc(suiteSchedules.createdAt));
    return rows.map(toRow);
  }

  /** Every schedule of every tenant (the API's resync of the job schedulers). */
  async listAll(): Promise<ScheduleRow[]> {
    return (await this.db.select().from(suiteSchedules)).map(toRow);
  }

  async find(tenantId: string, id: string): Promise<ScheduleRow | null> {
    const [row] = await this.db
      .select()
      .from(suiteSchedules)
      .where(and(eq(suiteSchedules.tenantId, tenantId), eq(suiteSchedules.id, id)));
    return row ? toRow(row) : null;
  }

  async findById(id: string): Promise<ScheduleRow | null> {
    const [row] = await this.db.select().from(suiteSchedules).where(eq(suiteSchedules.id, id));
    return row ? toRow(row) : null;
  }

  async counts(tenantId: string, suiteId: string): Promise<{ tenant: number; suite: number }> {
    const [tenant] = await this.db.select({ n: count() }).from(suiteSchedules).where(eq(suiteSchedules.tenantId, tenantId));
    const [suite] = await this.db.select({ n: count() }).from(suiteSchedules).where(eq(suiteSchedules.suiteId, suiteId));
    return { tenant: Number(tenant?.n ?? 0), suite: Number(suite?.n ?? 0) };
  }

  async create(input: { tenantId: string; suiteId: string; cron: string; timezone: string; enabled: boolean; createdBy: string | null }): Promise<ScheduleRow> {
    const [row] = await this.db
      .insert(suiteSchedules)
      .values({ id: newId("sch"), ...input })
      .returning();
    return toRow(row!);
  }

  async update(tenantId: string, id: string, input: { cron: string; timezone: string; enabled: boolean }): Promise<ScheduleRow | null> {
    const [row] = await this.db
      .update(suiteSchedules)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(suiteSchedules.tenantId, tenantId), eq(suiteSchedules.id, id)))
      .returning();
    return row ? toRow(row) : null;
  }

  async remove(tenantId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(suiteSchedules)
      .where(and(eq(suiteSchedules.tenantId, tenantId), eq(suiteSchedules.id, id)))
      .returning({ id: suiteSchedules.id });
    return rows.length > 0;
  }

  async recordFiring(id: string, at: Date, outcome: ScheduleOutcome, detail: { error?: string; suiteRunId?: string } = {}): Promise<void> {
    await this.db
      .update(suiteSchedules)
      .set({
        lastFiredAt: at,
        lastOutcome: outcome,
        lastError: detail.error ?? null,
        ...(detail.suiteRunId ? { lastSuiteRunId: detail.suiteRunId } : {}),
      })
      .where(eq(suiteSchedules.id, id));
  }
}
