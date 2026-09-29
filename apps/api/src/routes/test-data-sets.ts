import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiDeps } from "../deps";
import { TestDataSetService } from "../services/test-data-set-service";
import { parseOr400 } from "./test-runs";

const Params = z.object({ id: z.string().min(1).max(100) });

/** Saved test data sets (V1.1 F3). Any user of the tenant may read and manage them. */
export async function testDataSetRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const service = new TestDataSetService(deps);

  app.get("/v1/test-data-sets", async (req) => ({ items: await service.list(req.principal) }));

  app.post("/v1/test-data-sets", async (req, reply) => reply.status(201).send(await service.create(req.principal, req.body)));

  app.get("/v1/test-data-sets/:id", async (req) => service.get(req.principal, parseOr400(Params, req.params).id));

  app.put("/v1/test-data-sets/:id", async (req) => service.update(req.principal, parseOr400(Params, req.params).id, req.body));

  app.delete("/v1/test-data-sets/:id", async (req, reply) => {
    await service.remove(req.principal, parseOr400(Params, req.params).id);
    return reply.status(204).send();
  });
}
