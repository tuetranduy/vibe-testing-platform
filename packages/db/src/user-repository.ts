import type { UserRole, UserView } from "@platform/contracts";
import { and, asc, count, eq, gt, inArray, isNull, ne } from "drizzle-orm";
import type { Executor } from "./client";
import { newId } from "./ids";
import { auditEvents, userSessions, users } from "./schema";

export interface User {
  id: string;
  tenantId: string;
  email: string;
  name: string;
  passwordHash: string;
  role: UserRole;
  disabledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The API's view of a user: never the password hash. */
export function toUserView(u: User): UserView {
  return { id: u.id, email: u.email, name: u.name, role: u.role, disabled: u.disabledAt !== null, createdAt: u.createdAt.toISOString() };
}

/** Thrown when an e-mail is already taken in the tenant. */
export class EmailTakenError extends Error {
  constructor() {
    super("A user with this e-mail address already exists");
    this.name = "EmailTakenError";
  }
}

export function isUniqueViolation(err: unknown): boolean {
  let e: unknown = err;
  for (let i = 0; i < 3 && e; i++) {
    if ((e as { code?: string }).code === "23505") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/** Users of a tenant (V1.1 F1). Passwords arrive hashed; e-mails are stored lowercased. */
export class UserRepository {
  constructor(private readonly db: Executor) {}

  async create(input: { tenantId: string; email: string; name: string; passwordHash: string; role: UserRole }): Promise<User> {
    try {
      const [row] = await this.db
        .insert(users)
        .values({ id: newId("usr"), ...input, email: input.email.trim().toLowerCase() })
        .returning();
      return row!;
    } catch (err) {
      if (isUniqueViolation(err)) throw new EmailTakenError();
      throw err;
    }
  }

  async findById(tenantId: string, userId: string): Promise<User | null> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.id, userId)));
    return row ?? null;
  }

  async findByEmail(tenantId: string, email: string): Promise<User | null> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.email, email.trim().toLowerCase())));
    return row ?? null;
  }

  async list(tenantId: string): Promise<User[]> {
    return this.db.select().from(users).where(eq(users.tenantId, tenantId)).orderBy(asc(users.createdAt), asc(users.id));
  }

  async count(tenantId: string): Promise<number> {
    const [row] = await this.db.select({ n: count() }).from(users).where(eq(users.tenantId, tenantId));
    return Number(row?.n ?? 0);
  }

  /** Enabled admins other than `exceptUserId` (a tenant must always keep one). */
  async countOtherActiveAdmins(tenantId: string, exceptUserId: string): Promise<number> {
    const rows = await this.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.role, "admin"), isNull(users.disabledAt)));
    return rows.filter((r) => r.id !== exceptUserId).length;
  }

  async update(
    tenantId: string,
    userId: string,
    patch: { name?: string; role?: UserRole; disabledAt?: Date | null; passwordHash?: string },
  ): Promise<User | null> {
    const [row] = await this.db
      .update(users)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(users.tenantId, tenantId), eq(users.id, userId)))
      .returning();
    return row ?? null;
  }

  /** Display names by id, for run summaries (ids of other tenants are ignored). */
  async namesById(tenantId: string, ids: readonly string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await this.db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(and(eq(users.tenantId, tenantId), inArray(users.id, unique)));
    return new Map(rows.map((r) => [r.id, r.name]));
  }
}

export interface Session {
  id: string;
  userId: string;
  expiresAt: Date;
}

/** Web sessions: looked up by the token's hash, never by the token. */
export class SessionRepository {
  constructor(private readonly db: Executor) {}

  async create(input: { userId: string; tokenHash: Buffer; expiresAt: Date }): Promise<Session> {
    const [row] = await this.db
      .insert(userSessions)
      .values({ id: newId("ses"), ...input })
      .returning();
    return { id: row!.id, userId: row!.userId, expiresAt: row!.expiresAt };
  }

  /** The live session for a token hash, with its (enabled) user; null when unknown, expired, revoked or disabled. */
  async findLive(tokenHash: Buffer, now: Date = new Date()): Promise<{ session: Session; user: User } | null> {
    const [row] = await this.db
      .select({ session: userSessions, user: users })
      .from(userSessions)
      .innerJoin(users, eq(users.id, userSessions.userId))
      .where(
        and(
          eq(userSessions.tokenHash, tokenHash),
          isNull(userSessions.revokedAt),
          gt(userSessions.expiresAt, now),
          isNull(users.disabledAt),
        ),
      );
    if (!row) return null;
    return { session: { id: row.session.id, userId: row.session.userId, expiresAt: row.session.expiresAt }, user: row.user };
  }

  async touch(sessionId: string, at: Date = new Date()): Promise<void> {
    await this.db.update(userSessions).set({ lastSeenAt: at }).where(eq(userSessions.id, sessionId));
  }

  async revoke(sessionId: string): Promise<void> {
    await this.db
      .update(userSessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(userSessions.id, sessionId), isNull(userSessions.revokedAt)));
  }

  /** Revokes every live session of a user (disabled, password changed), except `exceptSessionId`. Returns how many. */
  async revokeAllForUser(userId: string, exceptSessionId?: string): Promise<number> {
    const rows = await this.db
      .update(userSessions)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(userSessions.userId, userId),
          isNull(userSessions.revokedAt),
          ...(exceptSessionId ? [ne(userSessions.id, exceptSessionId)] : []),
        ),
      )
      .returning({ id: userSessions.id });
    return rows.length;
  }
}

export interface AuditEntry {
  tenantId: string;
  userId: string | null;
  action: string;
  runId?: string | null;
  detail?: Record<string, unknown>;
}

export interface AuditRow extends Required<AuditEntry> {
  id: string;
  createdAt: Date;
}

/** The durable audit trail. Callers never put a secret, a password or a token in `detail`. */
export class AuditRepository {
  constructor(private readonly db: Executor) {}

  async append(entry: AuditEntry): Promise<void> {
    await this.db.insert(auditEvents).values({
      id: newId("aud"),
      tenantId: entry.tenantId,
      userId: entry.userId,
      action: entry.action,
      runId: entry.runId ?? null,
      detail: entry.detail ?? {},
    });
  }

  async listByTenant(tenantId: string, limit = 100): Promise<AuditRow[]> {
    const rows = await this.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.tenantId, tenantId))
      .orderBy(asc(auditEvents.createdAt), asc(auditEvents.id))
      .limit(limit);
    return rows.map((r) => ({ ...r, detail: r.detail as Record<string, unknown> }));
  }
}
