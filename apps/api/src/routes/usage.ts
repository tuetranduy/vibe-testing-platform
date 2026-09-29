import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "../deps";
import { UsageService } from "../services/usage-service";

/** The cost dashboard (V1.1 F7). */
export async function usageRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const service = new UsageService(deps);
  app.get("/v1/usage", async (req) => service.report(req.principal, req.query));
}
