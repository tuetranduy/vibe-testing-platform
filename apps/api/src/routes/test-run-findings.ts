import type { FastifyInstance } from "fastify";
import { CoverageQuerySchema } from "@platform/contracts";
import { z } from "zod";
import { runScope } from "../auth/principal";
import type { ApiDeps } from "../deps";
import { audit } from "../services/audit";
import { CoverageService } from "../services/coverage-service";
import { FindingService } from "../services/finding-service";
import { parseOr400 } from "./test-runs";

const RunParams = z.object({ runId: z.string().min(1).max(100) });
const FindingParams = RunParams.extend({ findingId: z.string().min(1).max(10) });

/** Phase C: a run's exploratory findings (unverified hypotheses), their review and independent reproduction. */
export async function testRunFindingRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const service = new FindingService(deps);

  // A site's coverage graph across the caller's recent runs (Phase C, plan §15.6).
  const coverage = new CoverageService(deps);
  app.get("/v1/discovery/coverage", async (req) => {
    const { url } = parseOr400(CoverageQuerySchema, req.query);
    return coverage.coverage(runScope(req.principal), url);
  });

  app.get("/v1/test-runs/:runId/findings", async (req) => {
    const { runId } = parseOr400(RunParams, req.params);
    return service.list(runScope(req.principal), runId);
  });

  app.post("/v1/test-runs/:runId/findings/:findingId/dismiss", async (req) => {
    const { runId, findingId } = parseOr400(FindingParams, req.params);
    const finding = await service.dismiss(runScope(req.principal), runId, findingId);
    await audit(deps, req, { action: "finding.dismissed", runId, detail: { findingId } });
    return finding;
  });

  app.post("/v1/test-runs/:runId/findings/:findingId/reproduce", async (req, reply) => {
    const { runId, findingId } = parseOr400(FindingParams, req.params);
    const result = await service.reproduce(req.principal, runScope(req.principal), runId, findingId);
    await audit(deps, req, { action: "finding.reproduction_started", runId, detail: { findingId, reproductionRunId: result.run.runId } });
    return reply.status(202).send(result);
  });
}
