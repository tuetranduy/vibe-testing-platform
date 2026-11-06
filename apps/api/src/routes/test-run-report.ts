import { renderReportMarkdown } from "@platform/testing-engine/reporting";
import { RunRepository } from "@platform/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { actorId, runScope } from "../auth/principal";
import type { ApiDeps } from "../deps";
import { ComparisonService } from "../services/comparison-service";
import { audit } from "../services/audit";
import { ReportService } from "../services/report-service";
import { parseOr400 } from "./test-runs";

const RunParams = z.object({ runId: z.string().min(1).max(100) });
const ComparisonQuery = z.object({ baseline: z.string().min(1).max(100).optional() });

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

  const comparisons = new ComparisonService(deps);

  // The same report as a Markdown download (V1.1 F6); same scope and readiness rules as the JSON one. A completed
  // run's file also compares it with the previous run of its test (V1.2 F2).
  app.get("/v1/test-runs/:runId/report.md", async (req, reply) => {
    const { runId } = parseOr400(RunParams, req.params);
    const scope = runScope(req.principal);
    const report = await service.get(scope, runId);
    let compared = null;
    if (report.lifecycle === "COMPLETED") {
      const { baseline, comparison } = await comparisons.resultsOf(scope, await new RunRepository(deps.db).getRequired(scope, runId));
      if (baseline) compared = { baselineRunId: baseline.id, comparison };
    }
    const file = `report-${runId.replace(/[^A-Za-z0-9_-]/g, "")}.md`;
    return reply
      .type("text/markdown; charset=utf-8")
      .header("content-disposition", `attachment; filename="${file}"`)
      .send(renderReportMarkdown(report, compared));
  });

  // How this run's result changed since an earlier run of the same test (V1.2 F2).
  app.get("/v1/test-runs/:runId/comparison", async (req) => {
    const { runId } = parseOr400(RunParams, req.params);
    const { baseline } = parseOr400(ComparisonQuery, req.query);
    return comparisons.compare(req.principal, runId, baseline);
  });
}
