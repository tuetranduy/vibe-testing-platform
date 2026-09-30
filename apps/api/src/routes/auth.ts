import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin } from "../auth/principal";
import type { ApiDeps } from "../deps";
import { HttpError } from "../errors";
import { audit } from "../services/audit";
import { UserService, emailHash } from "../services/user-service";
import { parseOr400 } from "./test-runs";

const UserParams = z.object({ userId: z.string().min(1).max(100) });

/**
 * Sign-in and accounts (V1.1 F1). `POST /v1/auth/login` needs no session; everything else takes the
 * caller's principal. User management is for admins (and the service token).
 */
export async function authRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const service = new UserService(deps);

  app.post("/v1/auth/login", async (req, reply) => {
    const tenantId = deps.config.defaultTenantId;
    const outcome = await service.login(tenantId, req.body);
    if (!outcome.ok) {
      const email = typeof (req.body as { email?: unknown } | undefined)?.email === "string" ? (req.body as { email: string }).email : "";
      await audit(deps, req, { action: "auth.login_failed", detail: { emailHash: emailHash(email), reason: outcome.reason } });
      if (outcome.reason === "throttled") {
        reply.header("retry-after", "900");
        throw new HttpError(429, "TOO_MANY_ATTEMPTS", "Too many failed sign-ins; try again in 15 minutes");
      }
      throw new HttpError(401, "INVALID_CREDENTIALS", "The e-mail address or password is not correct");
    }
    req.principal = {
      kind: "user",
      tenantId,
      userId: outcome.user.id,
      sessionId: "",
      role: outcome.user.role,
      name: outcome.user.name,
      email: outcome.user.email,
    };
    await audit(deps, req, { action: "auth.login" });
    return outcome.response;
  });

  app.post("/v1/auth/logout", async (req, reply) => {
    await service.logout(req.principal);
    if (req.principal.kind === "user") await audit(deps, req, { action: "auth.logout" });
    return reply.status(204).send();
  });

  app.get("/v1/auth/me", async (req) => service.me(req.principal));

  app.put("/v1/auth/password", async (req, reply) => {
    await service.changePassword(req.principal, req.body);
    await audit(deps, req, { action: "auth.password_changed" });
    return reply.status(204).send();
  });

  app.get("/v1/users", async (req) => {
    requireAdmin(req.principal);
    return { items: await service.list(req.principal.tenantId) };
  });

  app.post("/v1/users", async (req, reply) => {
    requireAdmin(req.principal);
    const user = await service.create(req.principal.tenantId, req.body);
    await audit(deps, req, { action: "user.created", detail: { targetUserId: user.id, role: user.role } });
    return reply.status(201).send(user);
  });

  app.patch("/v1/users/:userId", async (req) => {
    requireAdmin(req.principal);
    const { userId } = parseOr400(UserParams, req.params);
    const user = await service.update(req.principal, userId, req.body);
    const changed = Object.keys((req.body as Record<string, unknown>) ?? {}).filter((k) =>
      ["name", "role", "disabled", "password"].includes(k),
    );
    await audit(deps, req, { action: "user.updated", detail: { targetUserId: userId, changed } });
    return user;
  });
}
