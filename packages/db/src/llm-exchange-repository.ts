import { gunzipSync, gzipSync } from "node:zlib";
import { LlmExchangeSchema, type LlmExchange } from "@platform/contracts";
import { and, eq, inArray, lt } from "drizzle-orm";
import type { Executor } from "./client";
import { llmCallExchanges } from "./schema";

/**
 * Each model call's prompt and response as sent (admin run logs, 2026-11-25), gzipped JSON. The run's tenant
 * is set by the database from the run. Deleted by the retention job after RUN_LOG_RETENTION_DAYS.
 */
export class LlmExchangeRepository {
  constructor(private readonly db: Executor) {}

  async put(llmCallId: string, runId: string, exchange: LlmExchange): Promise<void> {
    const body = gzipSync(Buffer.from(JSON.stringify(LlmExchangeSchema.parse(exchange)), "utf8"));
    await this.db.insert(llmCallExchanges).values({ llmCallId, runId, body, bytes: body.length }).onConflictDoNothing();
  }

  /** Null when there is none, or it belongs to another tenant. */
  async get(tenantId: string, llmCallId: string): Promise<LlmExchange | null> {
    const [row] = await this.db
      .select({ body: llmCallExchanges.body })
      .from(llmCallExchanges)
      .where(and(eq(llmCallExchanges.llmCallId, llmCallId), eq(llmCallExchanges.tenantId, tenantId)));
    if (!row) return null;
    return LlmExchangeSchema.parse(JSON.parse(gunzipSync(row.body).toString("utf8")));
  }

  /** Stored (compressed) size; null when there is none. */
  async storedBytes(llmCallId: string): Promise<number | null> {
    const [row] = await this.db
      .select({ bytes: llmCallExchanges.bytes })
      .from(llmCallExchanges)
      .where(eq(llmCallExchanges.llmCallId, llmCallId));
    return row?.bytes ?? null;
  }

  /** The ids of the run's calls that still have an exchange. */
  async availability(runId: string): Promise<Set<string>> {
    const rows = await this.db
      .select({ id: llmCallExchanges.llmCallId })
      .from(llmCallExchanges)
      .where(eq(llmCallExchanges.runId, runId));
    return new Set(rows.map((r) => r.id));
  }

  /** Retention: deletes up to `limit` exchanges stored before `cutoff`; returns how many. */
  async deleteOlderThan(cutoff: Date, limit: number): Promise<number> {
    const batch = this.db
      .select({ id: llmCallExchanges.llmCallId })
      .from(llmCallExchanges)
      .where(lt(llmCallExchanges.createdAt, cutoff))
      .limit(limit);
    const deleted = await this.db
      .delete(llmCallExchanges)
      .where(inArray(llmCallExchanges.llmCallId, batch))
      .returning({ id: llmCallExchanges.llmCallId });
    return deleted.length;
  }
}
