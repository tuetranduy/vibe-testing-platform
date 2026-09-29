import { ExplorationCacheRepository } from "@platform/db";
import type { FastifyInstance } from "fastify";
import { requireAdmin } from "../auth/principal";
import type { ApiDeps } from "../deps";
import { audit } from "../services/audit";

/**
 * The tenant's exploration cache (V1.1 F8): how much it holds, and — for administrators — clearing it, e.g.
 * after a site redesign or to drop an element a page may have planted.
 */
export async function explorationCacheRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const repo = new ExplorationCacheRepository(deps.db);

  app.get("/v1/exploration-cache", async (req) => {
    const s = await repo.stats(req.principal.tenantId);
    return { entries: s.entries, hits: s.hits, lastUsedAt: s.lastUsedAt?.toISOString() ?? null };
  });

  app.delete("/v1/exploration-cache", async (req) => {
    requireAdmin(req.principal);
    const deleted = await repo.clear(req.principal.tenantId);
    await audit(deps, req, { action: "exploration_cache.cleared", detail: { deleted } });
    return { deleted };
  });
}
