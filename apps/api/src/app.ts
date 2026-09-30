import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { createBearerAuth } from "./auth/bearer";
import { createPrincipalResolver } from "./auth/principal";
import type { ApiDeps } from "./deps";
import { registerErrorHandler } from "./errors";
import { artifactRoutes } from "./routes/artifacts";
import { authRoutes } from "./routes/auth";
import { llmSettingsRoutes } from "./routes/llm-settings";
import { testRunCriteriaRoutes } from "./routes/test-run-criteria";
import { testRunSuggestionRoutes } from "./routes/test-run-suggestions";
import { testRunEventRoutes } from "./routes/test-run-events";
import { testRunReportRoutes } from "./routes/test-run-report";
import { testRunRoutes } from "./routes/test-runs";
import { testDataSetRoutes } from "./routes/test-data-sets";
import { credentialProfileRoutes } from "./routes/credential-profiles";
import { usageRoutes } from "./routes/usage";
import { explorationCacheRoutes } from "./routes/exploration-cache";
import { suiteRoutes } from "./routes/suites";
import { apiTokenRoutes } from "./routes/api-tokens";

export async function buildApp(deps: ApiDeps, opts: FastifyServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ bodyLimit: 1_000_000, ...opts });
  registerErrorHandler(app);

  // Accept an empty body with content-type: application/json (e.g. POST …/cancel from proxies).
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const text = typeof body === "string" ? body : body.toString("utf8");
    if (text.trim() === "") return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch {
      const err = Object.assign(new Error("Body is not valid JSON"), { statusCode: 400, code: "INVALID_JSON" });
      done(err, undefined);
    }
  });

  app.get("/healthz", async () => ({ ok: true }));
  if (deps.metrics) {
    const { registry } = deps.metrics;
    app.get("/metrics", async (_req, reply) => reply.type(registry.contentType).send(await registry.metrics()));
  }

  await app.register(async (v1) => {
    v1.addHook("onRequest", createBearerAuth(deps.config.apiToken));
    v1.addHook("onRequest", createPrincipalResolver(deps));
    await authRoutes(v1, deps);
    await testRunRoutes(v1, deps);
    await testRunCriteriaRoutes(v1, deps);
    await testRunSuggestionRoutes(v1, deps);
    await testRunEventRoutes(v1, deps);
    await testRunReportRoutes(v1, deps);
    await artifactRoutes(v1, deps);
    await llmSettingsRoutes(v1, deps);
    await testDataSetRoutes(v1, deps);
    await credentialProfileRoutes(v1, deps);
    await usageRoutes(v1, deps);
    await explorationCacheRoutes(v1, deps);
    await suiteRoutes(v1, deps);
    await apiTokenRoutes(v1, deps);
  });
  return app;
}
