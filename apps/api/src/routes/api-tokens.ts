import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiDeps } from "../deps";
import { ApiTokenService } from "../services/api-token-service";
import { audit } from "../services/audit";
import { parseOr400 } from "./test-runs";

const Params = z.object({ tokenId: z.string().min(1).max(100) });
const ListQuery = z.object({ user: z.enum(["me", "all"]).default("me") });

/** API tokens (V1.2 F4): managed from a web session only. */
export async function apiTokenRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const service = new ApiTokenService(deps);

  app.get("/v1/api-tokens", async (req) => ({
    items: await service.list(req.principal, parseOr400(ListQuery, req.query).user === "all"),
  }));

  app.post("/v1/api-tokens", async (req, reply) => {
    const created = await service.create(req.principal, req.body);
    await audit(deps, req, { action: "token.created", detail: { tokenId: created.id, name: created.name, scopes: created.scopes } });
    return reply.status(201).send(created);
  });

  app.delete("/v1/api-tokens/:tokenId", async (req) => {
    const revoked = await service.revoke(req.principal, parseOr400(Params, req.params).tokenId);
    await audit(deps, req, { action: "token.revoked", detail: { tokenId: revoked.id, ownerId: revoked.user.id } });
    return revoked;
  });
}
