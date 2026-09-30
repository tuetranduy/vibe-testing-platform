import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiDeps } from "../deps";
import { audit } from "../services/audit";
import { CredentialProfileService } from "../services/credential-profile-service";
import { parseOr400 } from "./test-runs";

const Params = z.object({ id: z.string().min(1).max(100) });

/** Saved credential profiles (V1.1 F4): names only, never a value. Changes are audited by name. */
export async function credentialProfileRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const service = new CredentialProfileService(deps);

  app.get("/v1/credential-profiles", async (req) => ({ items: await service.list(req.principal) }));

  app.post("/v1/credential-profiles", async (req, reply) => {
    const profile = await service.create(req.principal, req.body);
    await audit(deps, req, { action: "credential_profile.created", detail: { profileId: profile.id, secretNames: profile.secretNames } });
    return reply.status(201).send(profile);
  });

  app.put("/v1/credential-profiles/:id", async (req) => {
    const { id } = parseOr400(Params, req.params);
    const profile = await service.update(req.principal, id, req.body);
    const changed = Object.keys((req.body as { secrets?: object } | undefined)?.secrets ?? {});
    await audit(deps, req, { action: "credential_profile.updated", detail: { profileId: id, changedSecrets: changed } });
    return profile;
  });

  app.delete("/v1/credential-profiles/:id", async (req, reply) => {
    const { id } = parseOr400(Params, req.params);
    await service.remove(req.principal, id);
    await audit(deps, req, { action: "credential_profile.deleted", detail: { profileId: id } });
    return reply.status(204).send();
  });
}
