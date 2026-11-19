import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { runScope } from "../auth/principal";
import type { ApiDeps } from "../deps";
import { CriteriaService } from "../services/criteria-service";
import { parseOr400 } from "./test-runs";

const RunParams = z.object({ runId: z.string().min(1).max(100) });
const CriterionParams = RunParams.extend({ criterionId: z.string().regex(/^AC-\d{1,3}$/) });
const ProposalParams = RunParams.extend({ proposalId: z.string().min(1).max(200) });

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

  // 2026-11-19: a check rewritten from the user's words; the proposal is saved only when accepted.
  app.post("/v1/test-runs/:runId/criteria/:criterionId/revise", async (req) => {
    const { runId, criterionId } = parseOr400(CriterionParams, req.params);
    return service.revise(runScope(req.principal), runId, criterionId, req.body);
  });

  app.post("/v1/test-runs/:runId/criteria/proposals/:proposalId/accept", async (req) => {
    const { runId, proposalId } = parseOr400(ProposalParams, req.params);
    return service.accept(runScope(req.principal), runId, proposalId);
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
