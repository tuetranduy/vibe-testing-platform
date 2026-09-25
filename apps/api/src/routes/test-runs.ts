import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiDeps } from "../deps";
import { HttpError, zodIssues } from "../errors";
import { TestRunService } from "../services/test-run-service";

const RunParams = z.object({ runId: z.string().min(1).max(100) });
const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(500).optional(),
});

export function parseOr400<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new HttpError(400, "VALIDATION_FAILED", "Request validation failed", zodIssues(r.error));
  return r.data;
}

export async function testRunRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const service = new TestRunService(deps);

  app.post("/v1/test-runs", async (req, reply) => {
    const key = req.headers["idempotency-key"];
    const result = await service.create(req.body, typeof key === "string" && key.length > 0 ? key : undefined);
    return reply.status(result.status).send(result.body);
  });

  app.get("/v1/test-runs", async (req) => {
    const q = parseOr400(ListQuery, req.query);
    return service.list(q.limit, q.cursor ?? null);
  });

  app.get("/v1/test-runs/:runId", async (req) => {
    const { runId } = parseOr400(RunParams, req.params);
    return service.get(runId);
  });

  app.post("/v1/test-runs/:runId/cancel", async (req, reply) => {
    const { runId } = parseOr400(RunParams, req.params);
    return reply.status(202).send(await service.cancel(runId));
  });
}
