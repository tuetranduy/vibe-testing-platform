import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiDeps } from "../deps";
import { SuggestionService } from "../services/suggestion-service";
import { parseOr400 } from "./test-runs";

const RunParams = z.object({ runId: z.string().min(1).max(100) });

export async function testRunSuggestionRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const service = new SuggestionService(deps);

  app.get("/v1/test-runs/:runId/suggestions", async (req) => {
    const { runId } = parseOr400(RunParams, req.params);
    return service.get(runId);
  });

  app.post("/v1/test-runs/:runId/suggestions/select", async (req, reply) => {
    const { runId } = parseOr400(RunParams, req.params);
    return reply.status(202).send(await service.select(runId, req.body));
  });
}
