import { ArtifactRepository, RunRepository } from "@platform/db";
import { MAX_SIGNED_URL_TTL_SECONDS } from "@platform/storage";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiDeps } from "../deps";
import { HttpError } from "../errors";
import { parseOr400 } from "./test-runs";

const Params = z.object({ runId: z.string().min(1).max(100), artifactId: z.string().min(1).max(100) });
const Query = z.object({ reveal: z.enum(["true", "false"]).optional() });

export async function artifactRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  app.get("/v1/test-runs/:runId/artifacts/:artifactId/url", async (req) => {
    const { runId, artifactId } = parseOr400(Params, req.params);
    const { reveal } = parseOr400(Query, req.query);
    const tenantId = deps.config.defaultTenantId;
    await new RunRepository(deps.db).getRequired(tenantId, runId);
    const artifact = await new ArtifactRepository(deps.db).getRequired(tenantId, runId, artifactId);

    if (artifact.sensitivity === "SECRET_BEARING") {
      if (reveal !== "true") {
        throw new HttpError(403, "REVEAL_REQUIRED", "This artifact may contain entered credentials; pass reveal=true");
      }
      const entry = { action: "artifact.reveal", tenantId, runId, artifactId, type: artifact.type, at: new Date().toISOString() };
      req.log.warn(entry, "secret-bearing artifact revealed");
      deps.audit?.(entry);
    }

    const ttl = Math.min(deps.config.artifactUrlTtlSeconds, MAX_SIGNED_URL_TTL_SECONDS);
    const url = await deps.storage.getSignedReadUrl(artifact.objectKey, ttl);
    return { url, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() };
  });
}
