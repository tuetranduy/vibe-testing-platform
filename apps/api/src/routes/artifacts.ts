import { ArtifactRepository, RunRepository } from "@platform/db";
import { MAX_SIGNED_URL_TTL_SECONDS } from "@platform/storage";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { runScope } from "../auth/principal";
import type { ApiDeps } from "../deps";
import { audit } from "../services/audit";
import { HttpError } from "../errors";
import { parseOr400 } from "./test-runs";

const Params = z.object({ runId: z.string().min(1).max(100), artifactId: z.string().min(1).max(100) });
const Query = z.object({ reveal: z.enum(["true", "false"]).optional() });

export async function artifactRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  app.get("/v1/test-runs/:runId/artifacts/:artifactId/url", async (req) => {
    const { runId, artifactId } = parseOr400(Params, req.params);
    const { reveal } = parseOr400(Query, req.query);
    const scope = runScope(req.principal);
    const tenantId = scope.tenantId;
    await new RunRepository(deps.db).getRequired(scope, runId);
    const artifact = await new ArtifactRepository(deps.db).getRequired(tenantId, runId, artifactId);

    if (artifact.sensitivity === "SECRET_BEARING") {
      if (reveal !== "true") {
        throw new HttpError(403, "REVEAL_REQUIRED", "This artifact may contain entered credentials; pass reveal=true");
      }
      // Durable since V1.1 (KI-028): an audit_events row naming who revealed what.
      await audit(deps, req, { action: "artifact.reveal", runId, detail: { artifactId, type: artifact.type } });
    }

    const ttl = Math.min(deps.config.artifactUrlTtlSeconds, MAX_SIGNED_URL_TTL_SECONDS);
    const url = await deps.storage.getSignedReadUrl(artifact.objectKey, ttl);
    return { url, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() };
  });
}
