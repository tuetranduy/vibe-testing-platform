import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { runScope } from "../auth/principal";
import type { ApiDeps } from "../deps";
import { CriteriaService } from "../services/criteria-service";
import { parseOr400 } from "./test-runs";

const RunParams = z.object({ runId: z.string().min(1).max(100) });

export async function testRunCriteriaRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const service = new CriteriaService(deps);

  app.get("/v1/test-runs/:runId/criteria", async (req) => {
    const { runId } = parseOr400(RunParams, req.params);
    return service.get(runScope(req.principal), runId);
  });

  app.put("/v1/test-runs/:runId/criteria", async (req) => {
    const { runId } = parseOr400(RunParams, req.params);
    return service.update(runScope(req.principal), runId, req.body);
  });

  // V1.3: an optional body `{ testData }` adds the accepted test data suggestions to the run first.
  app.post("/v1/test-runs/:runId/criteria/confirm", async (req, reply) => {
    const { runId } = parseOr400(RunParams, req.params);
    return reply.status(202).send(await service.confirm(runScope(req.principal), runId, req.body ?? {}));
  });

  // V1.3: the requirement's analysis against the live site (pages read, per-criterion checks, suggested test data).
  app.get("/v1/test-runs/:runId/site-analysis", async (req) => {
    const { runId } = parseOr400(RunParams, req.params);
    return service.siteAnalysis(runScope(req.principal), runId);
  });
}
