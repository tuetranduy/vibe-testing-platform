import type { UserRole } from "@platform/contracts";
import { SessionRepository, type RunScope } from "@platform/db";
import { sessionTokenHash } from "@platform/security";
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
  | { kind: "user"; tenantId: string; userId: string; sessionId: string; role: UserRole; name: string; email: string };

declare module "fastify" {
  interface FastifyRequest {
    principal: Principal;
  }
}

export const SESSION_HEADER = "x-session-token";

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
export function createPrincipalResolver(deps: Pick<ApiDeps, "db" | "config">) {
  const sessions = new SessionRepository(deps.db);
  return async function resolvePrincipal(req: FastifyRequest, reply: FastifyReply) {
    const header = req.headers[SESSION_HEADER];
    const token = typeof header === "string" ? header.trim() : "";
    const route = `${req.method} ${req.routeOptions.url ?? ""}`;
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
