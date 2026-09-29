import { LlmKeyProviderSchema, ReasoningLevelSchema, type LlmKeyProvider, type ReasoningLevel } from "@platform/contracts";
import { and, asc, eq } from "drizzle-orm";
import type { Executor } from "./client";
import { llmProviderKeys, llmSettings } from "./schema";

/** A tenant's saved defaults for new tests (Settings → Defaults for new tests). */
export interface LlmDefaultsRow {
  model: string;
  reasoning: ReasoningLevel;
  updatedAt: Date;
}

/** Settings' saved defaults. No row: new runs use the LLM_* environment's defaults. */
export class LlmSettingsRepository {
  constructor(private readonly db: Executor) {}

  async get(tenantId: string): Promise<LlmDefaultsRow | null> {
    const [row] = await this.db.select().from(llmSettings).where(eq(llmSettings.tenantId, tenantId));
    return row ? { model: row.defaultModel, reasoning: row.defaultReasoning, updatedAt: row.updatedAt } : null;
  }

  /** Saves the defaults (the API has checked them against the catalog), replacing any saved before. */
  async upsertDefaults(tenantId: string, defaults: { model: string; reasoning: ReasoningLevel }): Promise<LlmDefaultsRow> {
    const set = { defaultModel: defaults.model, defaultReasoning: ReasoningLevelSchema.parse(defaults.reasoning), updatedAt: new Date() };
    const [row] = await this.db
      .insert(llmSettings)
      .values({ tenantId, ...set })
      .onConflictDoUpdate({ target: llmSettings.tenantId, set })
      .returning();
    return { model: row!.defaultModel, reasoning: row!.defaultReasoning, updatedAt: row!.updatedAt };
  }
}

/** A saved key as stored: the output of @platform/security's encryptProviderKey (db does not depend on security). */
export interface EncryptedProviderKey {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

/** Which providers have a saved key, and since when. Never the key. */
export interface ProviderKeyStatus {
  provider: LlmKeyProvider;
  updatedAt: Date;
}

/** Saved provider API keys, encrypted by the API before they reach this repository. */
export class ProviderKeyRepository {
  constructor(private readonly db: Executor) {}

  async listStatus(tenantId: string): Promise<ProviderKeyStatus[]> {
    const rows = await this.db
      .select({ provider: llmProviderKeys.provider, updatedAt: llmProviderKeys.updatedAt })
      .from(llmProviderKeys)
      .where(eq(llmProviderKeys.tenantId, tenantId))
      .orderBy(asc(llmProviderKeys.provider));
    return rows.map((r) => ({ provider: LlmKeyProviderSchema.parse(r.provider), updatedAt: r.updatedAt }));
  }

  /** Saves or replaces the tenant's key for `provider`. */
  async set(tenantId: string, provider: LlmKeyProvider, key: EncryptedProviderKey): Promise<ProviderKeyStatus> {
    const set = { ciphertext: key.ciphertext, iv: key.iv, authTag: key.authTag, updatedAt: new Date() };
    const [row] = await this.db
      .insert(llmProviderKeys)
      .values({ tenantId, provider: LlmKeyProviderSchema.parse(provider), ...set })
      .onConflictDoUpdate({ target: [llmProviderKeys.tenantId, llmProviderKeys.provider], set })
      .returning({ updatedAt: llmProviderKeys.updatedAt });
    return { provider, updatedAt: row!.updatedAt };
  }

  /** Deletes the saved key; false when there was none. */
  async remove(tenantId: string, provider: LlmKeyProvider): Promise<boolean> {
    const rows = await this.db
      .delete(llmProviderKeys)
      .where(and(eq(llmProviderKeys.tenantId, tenantId), eq(llmProviderKeys.provider, provider)))
      .returning({ provider: llmProviderKeys.provider });
    return rows.length > 0;
  }

  /** Worker only: what decryptProviderKey needs; null when no key is saved. */
  async getEncrypted(tenantId: string, provider: LlmKeyProvider): Promise<EncryptedProviderKey | null> {
    const [row] = await this.db
      .select({ ciphertext: llmProviderKeys.ciphertext, iv: llmProviderKeys.iv, authTag: llmProviderKeys.authTag })
      .from(llmProviderKeys)
      .where(and(eq(llmProviderKeys.tenantId, tenantId), eq(llmProviderKeys.provider, provider)));
    return row ?? null;
  }
}
