import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { createBearerAuth } from "./auth/bearer";
import type { ApiDeps } from "./deps";
import { registerErrorHandler } from "./errors";
import { artifactRoutes } from "./routes/artifacts";
import { testRunEventRoutes } from "./routes/test-run-events";
import { testRunRoutes } from "./routes/test-runs";

export async function buildApp(deps: ApiDeps, opts: FastifyServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ bodyLimit: 1_000_000, ...opts });
  registerErrorHandler(app);

  app.get("/healthz", async () => ({ ok: true }));

  await app.register(async (v1) => {
    v1.addHook("onRequest", createBearerAuth(deps.config.apiToken));
    await testRunRoutes(v1, deps);
    await testRunEventRoutes(v1, deps);
    await artifactRoutes(v1, deps);
  });
  return app;
}
