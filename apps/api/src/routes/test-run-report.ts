import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiDeps } from "../deps";
import { ReportService } from "../services/report-service";
import { parseOr400 } from "./test-runs";

const RunParams = z.object({ runId: z.string().min(1).max(100) });

export async function testRunReportRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const service = new ReportService(deps);

  app.get("/v1/test-runs/:runId/report", async (req) => {
    const { runId } = parseOr400(RunParams, req.params);
    return service.get(runId);
  });
}
