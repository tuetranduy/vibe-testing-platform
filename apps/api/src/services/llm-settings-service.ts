import {
  LlmSettingsViewSchema,
  type LlmChoice,
  type LlmDefaultsInput,
  type LlmKeyProvider,
  type LlmProvider,
  type LlmSettingsView,
} from "@platform/contracts";
import { LlmSettingsRepository, ProviderKeyRepository, type LlmDefaultsRow } from "@platform/db";
import { PROVIDER_LABELS, catalogModel } from "@platform/llm/catalog";
import { priceFor } from "@platform/llm/pricing";
import { encryptProviderKey } from "@platform/security";
import type { ApiDeps } from "../deps";
import { HttpError } from "../errors";
import { checkModel, offeredModels, providerAvailable, resolveRunLlm, type ChoiceIssue, type LlmAvailability } from "./llm-choice";

const KEY_PROVIDERS: readonly LlmKeyProvider[] = ["anthropic", "gemini", "deepseek"];

/** What decides which models a tenant's new runs may use: the saved defaults and keys, and the environment's. */
export interface LlmSettingsState {
  saved: LlmDefaultsRow | null;
  /** When each saved key was saved (never the key). */
  savedKeys: Map<LlmKeyProvider, Date>;
  availability: LlmAvailability;
}

/** 422 MODEL_NOT_AVAILABLE: the issue names the field and the fix. */
export function modelNotAvailable(issue: ChoiceIssue): HttpError {
  return new HttpError(422, "MODEL_NOT_AVAILABLE", issue.message, [issue]);
}

/** A saved model's provider: the catalog's (a model that left the catalog: by its id's prefix, for display). */
function providerOf(model: string): LlmProvider {
  const known = catalogModel(model)?.provider;
  if (known) return known;
  if (model.startsWith("gemini-")) return "gemini";
  return model.startsWith("deepseek-") ? "deepseek" : "anthropic";
}

/**
 * Settings → AI providers and defaults (spec 2026-09-28-llm-settings-design.md, sections 3–4). Keys are
 * encrypted here (encryptProviderKey) and never read back: the view reports only where each key comes from.
 */
export class LlmSettingsService {
  constructor(private readonly deps: ApiDeps) {}

  async state(tenantId: string): Promise<LlmSettingsState> {
    const [saved, keys] = await Promise.all([
      new LlmSettingsRepository(this.deps.db).get(tenantId),
      new ProviderKeyRepository(this.deps.db).listStatus(tenantId),
    ]);
    const savedKeys = new Map(keys.map((k) => [k.provider, k.updatedAt]));
    const { envKeys, fakeAllowed } = this.deps.config.llm;
    const keyed = (p: LlmKeyProvider) => savedKeys.has(p) || envKeys[p];
    return { saved, savedKeys, availability: { keys: { anthropic: keyed("anthropic"), gemini: keyed("gemini"), deepseek: keyed("deepseek") }, fakeAllowed } };
  }

  async view(tenantId: string): Promise<LlmSettingsView> {
    const { saved, savedKeys, availability } = await this.state(tenantId);
    const { envChoice, envKeys } = this.deps.config.llm;
    const defaults = saved
      ? { provider: providerOf(saved.model), model: saved.model, reasoning: saved.reasoning, source: "settings" as const }
      : { ...envChoice, source: "environment" as const };
    // Available exactly when a run on the defaults would be accepted.
    const available = resolveRunLlm({ override: undefined, saved, env: envChoice, availability }).ok;
    return LlmSettingsViewSchema.parse({
      defaults: { ...defaults, label: catalogModel(defaults.model)?.label ?? defaults.model, available },
      providers: KEY_PROVIDERS.map((provider) => ({
        provider,
        label: PROVIDER_LABELS[provider],
        key: {
          source: savedKeys.has(provider) ? "settings" : envKeys[provider] ? "environment" : null,
          updatedAt: savedKeys.get(provider)?.toISOString() ?? null,
        },
      })),
      models: offeredModels(availability).map((m) => ({
        provider: m.provider,
        id: m.id,
        label: m.label,
        reasoningLevels: m.reasoningLevels,
        defaultLevel: m.defaultLevel,
        price: priceFor(m.id),
        available: providerAvailable(m.provider, availability),
      })),
    });
  }

  /** Saves the defaults for new tests: an offered model whose provider has a key, at one of its levels (else 422). */
  async saveDefaults(tenantId: string, defaults: LlmDefaultsInput): Promise<LlmChoice> {
    const { availability } = await this.state(tenantId);
    const checked = checkModel(defaults.model, defaults.reasoning, availability, { model: ["defaults", "model"], reasoning: ["defaults", "reasoning"] });
    if (!checked.ok) throw modelNotAvailable(checked.issue);
    await new LlmSettingsRepository(this.deps.db).upsertDefaults(tenantId, checked.choice);
    return checked.choice;
  }

  /** Encrypts and saves (or replaces) a provider key; `null` removes the saved one ("unchanged" when none was saved). */
  async saveKey(tenantId: string, provider: LlmKeyProvider, apiKey: string | null): Promise<"saved" | "removed" | "unchanged"> {
    const keys = new ProviderKeyRepository(this.deps.db);
    if (apiKey === null) return (await keys.remove(tenantId, provider)) ? "removed" : "unchanged";
    await keys.set(tenantId, provider, encryptProviderKey(apiKey, { tenantId, provider }, this.deps.config.secretsKey));
    return "saved";
  }
}
