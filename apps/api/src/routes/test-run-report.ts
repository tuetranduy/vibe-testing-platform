import { renderReportMarkdown } from "@platform/testing-engine/reporting";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { actorId, runScope } from "../auth/principal";
import type { ApiDeps } from "../deps";
import { audit } from "../services/audit";
import { ReportService } from "../services/report-service";
import { parseOr400 } from "./test-runs";

const RunParams = z.object({ runId: z.string().min(1).max(100) });

export async function testRunReportRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const service = new ReportService(deps);

  app.get("/v1/test-runs/:runId/report", async (req) => {
    const { runId } = parseOr400(RunParams, req.params);
    return service.get(runScope(req.principal), runId);
  });

  app.post("/v1/test-runs/:runId/results/:criterionId/review", async (req) => {
    const { runId, criterionId } = parseOr400(z.object({ runId: RunParams.shape.runId, criterionId: z.string().regex(/^AC-[1-9]\d*$/) }), req.params);
    const { status } = parseOr400(z.object({ status: z.enum(["PASS", "FAIL"]) }).strict(), req.body);
    const report = await service.review(runScope(req.principal), runId, criterionId, status, actorId(req.principal));
    await audit(deps, req, { action: "criterion.reviewed", runId, detail: { criterionId, status } });
    return report;
  });

  // Same scope and readiness rules as the JSON report.
  app.get("/v1/test-runs/:runId/report.md", async (req, reply) => {
    const { runId } = parseOr400(RunParams, req.params);
    const scope = runScope(req.principal);
    const report = await service.get(scope, runId);
    const file = `report-${runId.replace(/[^A-Za-z0-9_-]/g, "")}.md`;
    return reply
      .type("text/markdown; charset=utf-8")
      .header("content-disposition", `attachment; filename="${file}"`)
      .send(renderReportMarkdown(report));
  });
}
