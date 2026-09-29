import { LlmKeyProviderSchema, ProviderKeyInputSchema, UpdateLlmSettingsRequestSchema } from "@platform/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ApiDeps } from "../deps";
import { HttpError } from "../errors";
import { LlmSettingsService } from "../services/llm-settings-service";
import { parseOr400 } from "./test-runs";

const KeyParams = z.object({ provider: z.string().min(1).max(40) });

/**
 * Settings → AI providers and defaults for new tests. Keys are write-only: no answer contains one, and the
 * audit lines name the provider (and model), never the key.
 */
export async function llmSettingsRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const service = new LlmSettingsService(deps);
  const tenantId = deps.config.defaultTenantId;
  const audit = (req: FastifyRequest, entry: { action: string } & Record<string, string>) => {
    const line = { ...entry, tenantId, at: new Date().toISOString() };
    req.log.info(line, "LLM settings changed");
    deps.audit?.(line);
  };

  app.get("/v1/settings/llm", async () => service.view(tenantId));

  app.put("/v1/settings/llm", async (req) => {
    const { defaults } = parseOr400(UpdateLlmSettingsRequestSchema, req.body);
    const saved = await service.saveDefaults(tenantId, defaults);
    audit(req, { action: "settings.llm.defaults_saved", provider: saved.provider, model: saved.model, reasoning: saved.reasoning });
    return service.view(tenantId);
  });

  app.put("/v1/settings/llm/keys/:provider", async (req) => {
    const provider = LlmKeyProviderSchema.safeParse(parseOr400(KeyParams, req.params).provider);
    if (!provider.success) throw new HttpError(404, "NOT_FOUND", "Not found");
    const { apiKey } = parseOr400(ProviderKeyInputSchema, req.body);
    const outcome = await service.saveKey(tenantId, provider.data, apiKey);
    if (outcome !== "unchanged") {
      audit(req, { action: outcome === "saved" ? "settings.llm.key_saved" : "settings.llm.key_removed", provider: provider.data });
    }
    return service.view(tenantId);
  });
}
