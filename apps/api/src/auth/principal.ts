import type { ApiTokenScope, UserRole } from "@platform/contracts";
import { ApiTokenRepository, SessionRepository, type RunScope } from "@platform/db";
import { apiTokenHash, sessionTokenHash } from "@platform/security";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ApiDeps } from "../deps";
import { HttpError } from "../errors";

/**
 * Who is calling (V1.1 F1). Every /v1 request carries the service bearer token; the web server adds the
 * signed-in user's session as `X-Session-Token`. Without that header the caller is the service itself
 * (scripts, the E2E suite): unrestricted, like V1.
 */
export type Principal =
  | { kind: "service"; tenantId: string }
  | {
      kind: "user";
      tenantId: string;
      userId: string;
      sessionId: string;
      role: UserRole;
      name: string;
      email: string;
      /** Set when the caller used an API token (V1.2 F4) rather than a web session. */
      token?: { id: string; name: string; scopes: ApiTokenScope[] };
    };

declare module "fastify" {
  interface FastifyRequest {
    principal: Principal;
  }
}

export const SESSION_HEADER = "x-session-token";
/** An API token (V1.2 F4), forwarded by the web app's external path. */
export const API_TOKEN_HEADER = "x-api-token";

/**
 * The only routes an API token reaches, with the scopes that open each (any one of them). Everything else —
 * token management included — answers `403 TOKEN_SCOPE` to a token.
 */
export const TOKEN_ROUTES: Readonly<Record<string, readonly ApiTokenScope[]>> = {
  "GET /v1/suites": ["suites:run", "results:read"],
  "POST /v1/suites/:suiteId/runs": ["suites:run"],
  "POST /v1/suite-runs/:suiteRunId/cancel": ["suites:run"],
  "GET /v1/suite-runs/:suiteRunId": ["results:read"],
  "GET /v1/suite-runs/:suiteRunId/junit.xml": ["results:read"],
  "GET /v1/test-runs/:runId": ["results:read"],
  "GET /v1/test-runs/:runId/report": ["results:read"],
  "GET /v1/test-runs/:runId/report.md": ["results:read"],
  "GET /v1/test-runs/:runId/comparison": ["results:read"],
};

/** Requests an API token may make per minute and per hour (V1.2 F4, KI-040); above either, `429`. */
export const TOKEN_REQUESTS_PER_MINUTE = 120;
export const TOKEN_REQUESTS_PER_HOUR = 600;

/** A token's request counts in the current minute and hour, this one included. */
export interface TokenHits {
  minute: number;
  hour: number;
}

/** Counts a token's requests per minute and per hour, shared by every API instance in production (Redis). */
export interface TokenThrottle {
  hit(tokenId: string): Promise<TokenHits>;
}

/** Process-local (tests, a single API instance); main.ts uses Redis. */
export function memoryTokenThrottle(now: () => number = Date.now): TokenThrottle {
  const hits = new Map<string, { minute: number; hour: number; perMinute: number; perHour: number }>();
  return {
    async hit(id) {
      const t = now();
      const minute = Math.floor(t / 60_000);
      const hour = Math.floor(t / 3_600_000);
      const cur = hits.get(id);
      const next = {
        minute,
        hour,
        perMinute: cur && cur.minute === minute ? cur.perMinute + 1 : 1,
        perHour: cur && cur.hour === hour ? cur.perHour + 1 : 1,
      };
      hits.set(id, next);
      return { minute: next.perMinute, hour: next.perHour };
    },
  };
}

export function redisTokenThrottle(redis: { incr(key: string): Promise<number>; expire(key: string, seconds: number): Promise<number> }): TokenThrottle {
  const count = async (key: string, seconds: number) => {
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, seconds);
    return n;
  };
  return {
    async hit(id) {
      const t = Date.now();
      const [minute, hour] = await Promise.all([
        count(`token-requests-minute:${id}:${Math.floor(t / 60_000)}`, 60),
        count(`token-requests:${id}:${Math.floor(t / 3_600_000)}`, 3600),
      ]);
      return { minute, hour };
    },
  };
}

/** Admins and the service see and manage everything in the tenant. */
export const isAdmin = (p: Principal): boolean => p.kind === "service" || p.role === "admin";

/** The runs this caller may see: all of the tenant's (admin, service), or only their own (member). */
export function runScope(p: Principal): RunScope {
  return isAdmin(p) ? { tenantId: p.tenantId } : { tenantId: p.tenantId, ownerUserId: p.kind === "user" ? p.userId : null };
}

/** The list scope: members always see their own runs; admins choose (`owner=me` or everything). */
export function listScope(p: Principal, owner: "me" | "all" | undefined): RunScope {
  if (p.kind === "user" && (owner === "me" || !isAdmin(p))) return { tenantId: p.tenantId, ownerUserId: p.userId };
  return { tenantId: p.tenantId };
}

/** The user id recorded as a run's owner / an audit row's actor; null for the service. */
export const actorId = (p: Principal): string | null => (p.kind === "user" ? p.userId : null);

export function requireAdmin(p: Principal): void {
  if (!isAdmin(p)) throw new HttpError(403, "FORBIDDEN", "Only an administrator can do this");
}

export function requireUser(p: Principal): Extract<Principal, { kind: "user" }> {
  if (p.kind !== "user") throw new HttpError(400, "NO_SESSION", "This endpoint needs a signed-in user");
  return p;
}

/** Routes that need no session (the login itself). */
const OPEN_ROUTES = new Set(["POST /v1/auth/login"]);

/**
 * onRequest hook, after the bearer check: resolves the session header into a user principal, or the
 * service principal when there is none. A header that names no live session is 401, never silently the
 * service: the web proxy always sends one, so a stale cookie must not fall back to full access.
 */
export function createPrincipalResolver(deps: Pick<ApiDeps, "db" | "config" | "tokenThrottle">) {
  const sessions = new SessionRepository(deps.db);
  const tokens = new ApiTokenRepository(deps.db);
  const throttle = deps.tokenThrottle ?? memoryTokenThrottle();
  return async function resolvePrincipal(req: FastifyRequest, reply: FastifyReply) {
    const header = req.headers[SESSION_HEADER];
    const token = typeof header === "string" ? header.trim() : "";
    const route = `${req.method} ${req.routeOptions.url ?? ""}`;
    const apiHeader = req.headers[API_TOKEN_HEADER];
    const apiToken = typeof apiHeader === "string" ? apiHeader.trim() : "";
    if (apiToken) {
      if (token) return reply.status(400).send({ code: "CREDENTIALS_CONFLICT", message: "Send a session or an API token, not both" });
      const found = /^tap_[A-Za-z0-9_-]{20,100}$/.test(apiToken) ? await tokens.findLive(apiTokenHash(apiToken)) : null;
      if (!found) return reply.status(401).send({ code: "TOKEN_INVALID", message: "This API token is unknown, expired or revoked" });
      const allowed = TOKEN_ROUTES[route];
      if (!allowed || !allowed.some((scope) => found.token.scopes.includes(scope))) {
        return reply.status(403).send({ code: "TOKEN_SCOPE", message: "This API token may not do this" });
      }
      const hits = await throttle.hit(found.token.id);
      if (hits.minute > TOKEN_REQUESTS_PER_MINUTE || hits.hour > TOKEN_REQUESTS_PER_HOUR) {
        reply.header("retry-after", hits.hour > TOKEN_REQUESTS_PER_HOUR ? "3600" : "60");
        return reply.status(429).send({ code: "TOO_MANY_REQUESTS", message: "This API token made too many requests; wait and retry" });
      }
      const { user } = found;
      req.principal = {
        kind: "user",
        tenantId: user.tenantId,
        userId: user.id,
        sessionId: `token:${found.token.id}`,
        role: user.role,
        name: user.name,
        email: user.email,
        token: { id: found.token.id, name: found.token.name, scopes: found.token.scopes },
      };
      tokens.touch(found.token.id).catch(() => {});
      return;
    }
    if (!token || OPEN_ROUTES.has(route)) {
      req.principal = { kind: "service", tenantId: deps.config.defaultTenantId };
      return;
    }
    const found = token.length <= 200 ? await sessions.findLive(sessionTokenHash(token)) : null;
    if (!found) {
      return reply.status(401).send({ code: "SESSION_INVALID", message: "Your session has ended; sign in again" });
    }
    const { session, user } = found;
    req.principal = {
      kind: "user",
      tenantId: user.tenantId,
      userId: user.id,
      sessionId: session.id,
      role: user.role,
      name: user.name,
      email: user.email,
    };
    // Best effort: a failed touch never fails the request.
    sessions.touch(session.id).catch(() => {});
  };
}
