import { LlmKeyProviderSchema, ProviderKeyInputSchema, UpdateLlmSettingsRequestSchema } from "@platform/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { requireAdmin } from "../auth/principal";
import { z } from "zod";
import type { ApiDeps } from "../deps";
import { HttpError } from "../errors";
import { audit as recordAudit } from "../services/audit";
import { LlmSettingsService } from "../services/llm-settings-service";
import { parseOr400 } from "./test-runs";

const KeyParams = z.object({ provider: z.string().min(1).max(40) });

/**
 * Settings → AI providers and defaults for new tests. Keys are write-only: no answer contains one, and the
 * audit lines name the provider (and model), never the key.
 */
export async function llmSettingsRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const service = new LlmSettingsService(deps);
  const audit = ({ action, ...detail }: { action: string } & Record<string, string>, req: FastifyRequest) =>
    recordAudit(deps, req, { action, detail });

  // Everyone may read the settings (the new-test form offers the models); only admins change them (V1.1 F1).
  app.get("/v1/settings/llm", async (req) => service.view(req.principal.tenantId));

  app.put("/v1/settings/llm", async (req) => {
    requireAdmin(req.principal);
    const tenantId = req.principal.tenantId;
    const { defaults } = parseOr400(UpdateLlmSettingsRequestSchema, req.body);
    const saved = await service.saveDefaults(tenantId, defaults);
    await audit({ action: "settings.llm.defaults_saved", provider: saved.provider, model: saved.model, reasoning: saved.reasoning }, req);
    return service.view(tenantId);
  });

  app.put("/v1/settings/llm/keys/:provider", async (req) => {
    requireAdmin(req.principal);
    const tenantId = req.principal.tenantId;
    const provider = LlmKeyProviderSchema.safeParse(parseOr400(KeyParams, req.params).provider);
    if (!provider.success) throw new HttpError(404, "NOT_FOUND", "Not found");
    const { apiKey } = parseOr400(ProviderKeyInputSchema, req.body);
    const outcome = await service.saveKey(tenantId, provider.data, apiKey);
    if (outcome !== "unchanged") {
      await audit({ action: outcome === "saved" ? "settings.llm.key_saved" : "settings.llm.key_removed", provider: provider.data }, req);
    }
    return service.view(tenantId);
  });
}
