import { CachedElementSchema, type CachedElement } from "@platform/contracts";
import { and, count, eq, lt, max, sql } from "drizzle-orm";
import type { Executor } from "./client";
import { explorationCache } from "./schema";

/** The exploration cache (V1.1 F8), tenant-scoped. Entries hold selectors and locators, never page values. */
export class ExplorationCacheRepository {
  constructor(private readonly db: Executor) {}

  /** The entry for a key, or null (also when a stored entry no longer parses). */
  async get(tenantId: string, key: string): Promise<CachedElement | null> {
    const [row] = await this.db
      .select({ entry: explorationCache.entry })
      .from(explorationCache)
      .where(and(eq(explorationCache.tenantId, tenantId), eq(explorationCache.key, key)));
    const parsed = row ? CachedElementSchema.safeParse(row.entry) : null;
    return parsed?.success ? parsed.data : null;
  }

  /** Saves or replaces an entry. */
  async put(tenantId: string, key: string, where: { origin: string; path: string }, entry: CachedElement): Promise<void> {
    const values = { entry: CachedElementSchema.parse(entry), origin: where.origin, path: where.path, lastUsedAt: new Date() };
    await this.db
      .insert(explorationCache)
      .values({ tenantId, key, ...values })
      .onConflictDoUpdate({ target: [explorationCache.tenantId, explorationCache.key], set: values });
  }

  /** Counts a reuse. */
  async touch(tenantId: string, key: string): Promise<void> {
    await this.db
      .update(explorationCache)
      .set({ hits: sql`${explorationCache.hits} + 1`, lastUsedAt: new Date() })
      .where(and(eq(explorationCache.tenantId, tenantId), eq(explorationCache.key, key)));
  }

  /** How many entries the tenant has, how often they were reused, and when last. */
  async stats(tenantId: string): Promise<{ entries: number; hits: number; lastUsedAt: Date | null }> {
    const [row] = await this.db
      .select({
        entries: count(),
        hits: sql<number>`coalesce(sum(${explorationCache.hits}), 0)`,
        lastUsedAt: max(explorationCache.lastUsedAt),
      })
      .from(explorationCache)
      .where(eq(explorationCache.tenantId, tenantId));
    return { entries: Number(row?.entries ?? 0), hits: Number(row?.hits ?? 0), lastUsedAt: row?.lastUsedAt ?? null };
  }

  /** Deletes the tenant's whole cache; returns how many entries. */
  async clear(tenantId: string): Promise<number> {
    const rows = await this.db
      .delete(explorationCache)
      .where(eq(explorationCache.tenantId, tenantId))
      .returning({ key: explorationCache.key });
    return rows.length;
  }

  /** Retention: deletes entries (every tenant's) unused since `before`. */
  async deleteUnusedSince(before: Date): Promise<number> {
    const rows = await this.db
      .delete(explorationCache)
      .where(lt(explorationCache.lastUsedAt, before))
      .returning({ key: explorationCache.key });
    return rows.length;
  }
}
