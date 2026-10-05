import {
  ChangePasswordRequestSchema,
  CreateUserRequestSchema,
  LoginRequestSchema,
  UpdateUserRequestSchema,
  type LoginResponse,
  type SessionInfo,
  type UserView,
} from "@platform/contracts";
import { ApiTokenRepository, EmailTakenError, SessionRepository, UserRepository, toUserView, type User } from "@platform/db";
import { hashPassword, newSessionToken, sessionTokenHash, verifyPassword } from "@platform/security";
import { createHash } from "node:crypto";
import { requireUser, type Principal } from "../auth/principal";
import type { ApiConfig, ApiDeps } from "../deps";
import { HttpError, zodIssues } from "../errors";

/** Failed logins allowed per e-mail within the window, then 429 until it passes. */
export const LOGIN_MAX_FAILURES = 10;
export const LOGIN_WINDOW_SECONDS = 15 * 60;

/** Counts failed logins per key (an e-mail hash) over a fixed window. */
export interface LoginThrottle {
  failures(key: string): Promise<number>;
  fail(key: string): Promise<void>;
  reset(key: string): Promise<void>;
}

/** Process-local throttle (tests, single-instance use). The API uses Redis (main.ts). */
export function memoryLoginThrottle(now: () => number = Date.now): LoginThrottle {
  const hits = new Map<string, number[]>();
  const live = (key: string) => (hits.get(key) ?? []).filter((t) => t > now() - LOGIN_WINDOW_SECONDS * 1000);
  return {
    async failures(key) {
      return live(key).length;
    },
    async fail(key) {
      hits.set(key, [...live(key), now()]);
    },
    async reset(key) {
      hits.delete(key);
    },
  };
}

/** Redis throttle: INCR with a TTL set on the first failure of a window. */
export function redisLoginThrottle(redis: {
  get(key: string): Promise<string | null>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  del(key: string): Promise<number>;
}): LoginThrottle {
  const k = (key: string) => `login-failures:${key}`;
  return {
    async failures(key) {
      return Number((await redis.get(k(key))) ?? 0);
    },
    async fail(key) {
      if ((await redis.incr(k(key))) === 1) await redis.expire(k(key), LOGIN_WINDOW_SECONDS);
    },
    async reset(key) {
      await redis.del(k(key));
    },
  };
}

/** What an audit row may name for a failed login: never the typed e-mail itself. */
export const emailHash = (email: string) => createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 16);

const invalid = (err: import("zod").ZodError) => new HttpError(400, "VALIDATION_FAILED", "Request validation failed", zodIssues(err));

function parse<T>(
  schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: import("zod").ZodError } },
  body: unknown,
): T {
  const r = schema.safeParse(body);
  if (!r.success) throw invalid(r.error);
  return r.data;
}

export type LoginOutcome = { ok: true; response: LoginResponse; user: User } | { ok: false; reason: "invalid" | "throttled" };

/** A signed-in user acting through a web session (an API token's principal is not one). */
function requireSession(principal: Principal) {
  const p = requireUser(principal);
  if (p.sessionId.startsWith("token:")) throw new HttpError(400, "NO_SESSION", "This endpoint needs a signed-in user");
  return p;
}

/** Accounts, sessions and user management (V1.1 F1, spec 2026-09-29-v1.1-design). */
export class UserService {
  private readonly users: UserRepository;
  private readonly sessions: SessionRepository;

  constructor(private readonly deps: Pick<ApiDeps, "db" | "loginThrottle"> & { config: Pick<ApiConfig, "auth"> }) {
    this.users = new UserRepository(deps.db);
    this.sessions = new SessionRepository(deps.db);
  }

  private hash(password: string): Promise<string> {
    return hashPassword(password, this.deps.config.auth.passwordHashN ? { N: this.deps.config.auth.passwordHashN } : {});
  }

  private throttle(): LoginThrottle {
    return this.deps.loginThrottle ?? fallbackThrottle;
  }

  /**
   * Checks the password (an unknown or disabled account costs the same scrypt), counts failures per
   * e-mail, and opens a session: the token is returned once, only its hash is stored.
   */
  async login(tenantId: string, body: unknown, userAgent?: string): Promise<LoginOutcome> {
    const { email, password } = parse(LoginRequestSchema, body);
    const key = `${tenantId}:${emailHash(email)}`;
    if ((await this.throttle().failures(key)) >= LOGIN_MAX_FAILURES) return { ok: false, reason: "throttled" };
    const user = await this.users.findByEmail(tenantId, email);
    const usable = user && user.disabledAt === null ? user : null;
    const ok = await verifyPassword(password, usable?.passwordHash ?? null);
    if (!ok || !usable) {
      await this.throttle().fail(key);
      return { ok: false, reason: "invalid" };
    }
    await this.throttle().reset(key);
    const token = newSessionToken();
    const expiresAt = new Date(Date.now() + this.deps.config.auth.sessionTtlHours * 3_600_000);
    await this.sessions.create({ userId: usable.id, tokenHash: sessionTokenHash(token), expiresAt, userAgent: userAgent?.slice(0, 300) || null });
    return { ok: true, user: usable, response: { token, expiresAt: expiresAt.toISOString(), user: toUserView(usable) } };
  }

  async logout(principal: Principal): Promise<void> {
    if (principal.kind === "user") await this.sessions.revoke(principal.sessionId);
  }

  async me(principal: Principal): Promise<UserView> {
    const p = requireUser(principal);
    const user = await this.users.findById(p.tenantId, p.userId);
    if (!user) throw new HttpError(401, "SESSION_INVALID", "Your session has ended; sign in again");
    return toUserView(user);
  }

  /** The signed-in user's live sessions (KI-034); API tokens are not sessions and are listed on their own page. */
  async sessionsOf(principal: Principal): Promise<SessionInfo[]> {
    const p = requireSession(principal);
    return (await this.sessions.listLive(p.userId)).map((s) => ({
      id: s.id,
      createdAt: s.createdAt.toISOString(),
      lastSeenAt: s.lastSeenAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
      userAgent: s.userAgent,
      current: s.id === p.sessionId,
    }));
  }

  /** Ends one of the signed-in user's own sessions; 404 for any other (or an ended one). */
  async revokeSession(principal: Principal, sessionId: string): Promise<void> {
    const p = requireSession(principal);
    if (!(await this.sessions.revokeOwn(p.userId, sessionId))) throw new HttpError(404, "NOT_FOUND", "Not found");
  }

  /** "Sign out other sessions": every live session of the user but this one. */
  async revokeOtherSessions(principal: Principal): Promise<number> {
    const p = requireSession(principal);
    return this.sessions.revokeAllForUser(p.userId, p.sessionId);
  }

  /** A user changes their own password: their other sessions end, this one stays. */
  async changePassword(principal: Principal, body: unknown): Promise<void> {
    const p = requireUser(principal);
    const { currentPassword, newPassword } = parse(ChangePasswordRequestSchema, body);
    const user = await this.users.findById(p.tenantId, p.userId);
    if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) {
      throw new HttpError(400, "VALIDATION_FAILED", "Request validation failed", [
        { path: ["currentPassword"], message: "The current password is not correct" },
      ]);
    }
    await this.users.update(p.tenantId, p.userId, { passwordHash: await this.hash(newPassword) });
    await this.sessions.revokeAllForUser(p.userId, p.sessionId);
  }

  async list(tenantId: string): Promise<UserView[]> {
    return (await this.users.list(tenantId)).map(toUserView);
  }

  async create(tenantId: string, body: unknown): Promise<UserView> {
    const input = parse(CreateUserRequestSchema, body);
    try {
      const user = await this.users.create({
        tenantId,
        email: input.email,
        name: input.name,
        role: input.role,
        passwordHash: await this.hash(input.password),
      });
      return toUserView(user);
    } catch (err) {
      if (err instanceof EmailTakenError) {
        throw new HttpError(409, "EMAIL_TAKEN", err.message, [{ path: ["email"], message: err.message }]);
      }
      throw err;
    }
  }

  /**
   * An admin changes a user. The tenant always keeps an enabled admin: nobody can disable or demote
   * the last one (themselves included). A new password or disabling revokes the user's sessions.
   */
  async update(principal: Principal, userId: string, body: unknown): Promise<UserView> {
    const patch = parse(UpdateUserRequestSchema, body);
    const tenantId = principal.tenantId;
    const user = await this.users.findById(tenantId, userId);
    if (!user) throw new HttpError(404, "NOT_FOUND", "Not found");

    const losesAdmin = user.role === "admin" && user.disabledAt === null && (patch.role === "member" || patch.disabled === true);
    if (losesAdmin && (await this.users.countOtherActiveAdmins(tenantId, userId)) === 0) {
      throw new HttpError(409, "LAST_ADMIN", "Keep at least one enabled administrator");
    }
    const updated = await this.users.update(tenantId, userId, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.role !== undefined ? { role: patch.role } : {}),
      ...(patch.disabled !== undefined ? { disabledAt: patch.disabled ? (user.disabledAt ?? new Date()) : null } : {}),
      ...(patch.password !== undefined ? { passwordHash: await this.hash(patch.password) } : {}),
    });
    if (patch.password !== undefined || patch.disabled === true) {
      // An admin resetting their own password keeps the session they did it from.
      const keep = principal.kind === "user" && principal.userId === userId ? principal.sessionId : undefined;
      await this.sessions.revokeAllForUser(userId, keep);
    }
    // A disabled person's API tokens stop working for good (V1.2 F4); enabling them again doesn't bring them back.
    if (patch.disabled === true) await new ApiTokenRepository(this.deps.db).revokeAllForUser(userId);
    return toUserView(updated!);
  }

  /**
   * BOOTSTRAP_ADMIN_EMAIL / _PASSWORD: the first admin, created only while the tenant has no user at
   * all. Returns whether it was created.
   */
  async bootstrapAdmin(tenantId: string, email: string, password: string): Promise<boolean> {
    if ((await this.users.count(tenantId)) > 0) return false;
    const input = parse(CreateUserRequestSchema, { email, name: "Administrator", password, role: "admin" });
    try {
      await this.users.create({
        tenantId,
        email: input.email,
        name: input.name,
        role: "admin",
        passwordHash: await this.hash(input.password),
      });
      return true;
    } catch (err) {
      if (err instanceof EmailTakenError) return false; // another API instance won the race
      throw err;
    }
  }
}

const fallbackThrottle = memoryLoginThrottle();
