import { renderReportMarkdown } from "@platform/testing-engine/reporting";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { runScope } from "../auth/principal";
import type { ApiDeps } from "../deps";
import { ReportService } from "../services/report-service";
import { parseOr400 } from "./test-runs";

const RunParams = z.object({ runId: z.string().min(1).max(100) });

export async function testRunReportRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const service = new ReportService(deps);

  app.get("/v1/test-runs/:runId/report", async (req) => {
    const { runId } = parseOr400(RunParams, req.params);
    return service.get(runScope(req.principal), runId);
  });

  // The same report as a Markdown download (V1.1 F6); same scope and readiness rules as the JSON one.
  app.get("/v1/test-runs/:runId/report.md", async (req, reply) => {
    const { runId } = parseOr400(RunParams, req.params);
    const report = await service.get(runScope(req.principal), runId);
    const file = `report-${runId.replace(/[^A-Za-z0-9_-]/g, "")}.md`;
    return reply
      .type("text/markdown; charset=utf-8")
      .header("content-disposition", `attachment; filename="${file}"`)
      .send(renderReportMarkdown(report));
  });
}
