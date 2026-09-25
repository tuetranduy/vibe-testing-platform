import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiDeps } from "../deps";
import { CriteriaService } from "../services/criteria-service";
import { parseOr400 } from "./test-runs";

const RunParams = z.object({ runId: z.string().min(1).max(100) });

export async function testRunCriteriaRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const service = new CriteriaService(deps);

  app.get("/v1/test-runs/:runId/criteria", async (req) => {
    const { runId } = parseOr400(RunParams, req.params);
    return service.get(runId);
  });

  app.put("/v1/test-runs/:runId/criteria", async (req) => {
    const { runId } = parseOr400(RunParams, req.params);
    return service.update(runId, req.body);
  });

  app.post("/v1/test-runs/:runId/criteria/confirm", async (req, reply) => {
    const { runId } = parseOr400(RunParams, req.params);
    return reply.status(202).send(await service.confirm(runId));
  });
}
