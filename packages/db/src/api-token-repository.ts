import type { ApiTokenScope } from "@platform/contracts";
import { and, count, desc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import type { Executor } from "./client";
import { newId } from "./ids";
import { apiTokens, users } from "./schema";
import type { User } from "./user-repository";

export interface ApiTokenRow {
  id: string;
  tenantId: string;
  userId: string;
  name: string;
  prefix: string;
  scopes: ApiTokenScope[];
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

const toRow = ({ tokenHash: _hash, ...r }: typeof apiTokens.$inferSelect): ApiTokenRow => ({ ...r, scopes: r.scopes as ApiTokenScope[] });

/** API tokens (V1.2 F4). Hashes go in; a token is found by its hash and never read back. */
export class ApiTokenRepository {
  constructor(private readonly db: Executor) {}

  async create(input: {
    tenantId: string;
    userId: string;
    name: string;
    tokenHash: Buffer;
    prefix: string;
    scopes: ApiTokenScope[];
    expiresAt: Date | null;
  }): Promise<ApiTokenRow> {
    const [row] = await this.db
      .insert(apiTokens)
      .values({ id: newId("tok"), ...input })
      .returning();
    return toRow(row!);
  }

  /** Newest first: one user's, or (no `userId`) the tenant's. */
  async list(tenantId: string, userId?: string): Promise<ApiTokenRow[]> {
    const rows = await this.db
      .select()
      .from(apiTokens)
      .where(userId ? and(eq(apiTokens.tenantId, tenantId), eq(apiTokens.userId, userId)) : eq(apiTokens.tenantId, tenantId))
      .orderBy(desc(apiTokens.createdAt), desc(apiTokens.id));
    return rows.map(toRow);
  }

  async find(tenantId: string, id: string): Promise<ApiTokenRow | null> {
    const [row] = await this.db
      .select()
      .from(apiTokens)
      .where(and(eq(apiTokens.tenantId, tenantId), eq(apiTokens.id, id)));
    return row ? toRow(row) : null;
  }

  /** Not revoked and not expired. */
  async countLive(userId: string, now: Date = new Date()): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(apiTokens)
      .where(and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt), or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, now))));
    return Number(row?.n ?? 0);
  }

  /** A live token (not revoked, not expired) of an enabled user, by the hash of what the caller sent. */
  async findLive(tokenHash: Buffer, now: Date = new Date()): Promise<{ token: ApiTokenRow; user: User } | null> {
    const [row] = await this.db
      .select({ token: apiTokens, user: users })
      .from(apiTokens)
      .innerJoin(users, eq(users.id, apiTokens.userId))
      .where(
        and(
          eq(apiTokens.tokenHash, tokenHash),
          isNull(apiTokens.revokedAt),
          or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, now)),
          isNull(users.disabledAt),
        ),
      );
    return row ? { token: toRow(row.token), user: row.user } : null;
  }

  /** Records a use, at most once a minute per token (a busy CI job doesn't write on every request). */
  async touch(id: string, at: Date = new Date()): Promise<void> {
    await this.db
      .update(apiTokens)
      .set({ lastUsedAt: at })
      .where(and(eq(apiTokens.id, id), or(isNull(apiTokens.lastUsedAt), lt(apiTokens.lastUsedAt, new Date(at.getTime() - 60_000)))));
  }

  /** Returns the row when this call revoked it. */
  async revoke(tenantId: string, id: string, at: Date = new Date()): Promise<ApiTokenRow | null> {
    const [row] = await this.db
      .update(apiTokens)
      .set({ revokedAt: at })
      .where(and(eq(apiTokens.tenantId, tenantId), eq(apiTokens.id, id), isNull(apiTokens.revokedAt)))
      .returning();
    return row ? toRow(row) : null;
  }

  async revokeAllForUser(userId: string, at: Date = new Date()): Promise<number> {
    const rows = await this.db
      .update(apiTokens)
      .set({ revokedAt: sql`coalesce(${apiTokens.revokedAt}, ${at.toISOString()}::timestamptz)` })
      .where(and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)))
      .returning({ id: apiTokens.id });
    return rows.length;
  }
}
