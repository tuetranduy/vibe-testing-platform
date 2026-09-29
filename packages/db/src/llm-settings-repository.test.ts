import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LlmSettingsRepository, ProviderKeyRepository } from "./llm-settings-repository";
import { OTHER_TENANT_ID, TEST_TENANT_ID, createTestDatabase, type TestDatabase } from "./testing";

let tdb: TestDatabase;
beforeAll(async () => {
  tdb = await createTestDatabase();
});
afterAll(async () => tdb?.drop());

/** Stand-in ciphertext (the API encrypts with encryptProviderKey before saving). */
const encrypted = (tag: string) => ({ ciphertext: Buffer.from(`cipher-${tag}`), iv: Buffer.alloc(12, 1), authTag: Buffer.alloc(16, 2) });

describe("LlmSettingsRepository", () => {
  it("has no row until defaults are saved; saving again replaces them, per tenant", async () => {
    const repo = new LlmSettingsRepository(tdb.db);
    expect(await repo.get(TEST_TENANT_ID)).toBeNull();
    const first = await repo.upsertDefaults(TEST_TENANT_ID, { model: "claude-sonnet-5", reasoning: "default" });
    expect(first).toMatchObject({ model: "claude-sonnet-5", reasoning: "default" });
    const second = await repo.upsertDefaults(TEST_TENANT_ID, { model: "gemini-3.8-flash", reasoning: "low" });
    expect(await repo.get(TEST_TENANT_ID)).toEqual(second);
    expect(second.updatedAt.getTime()).toBeGreaterThanOrEqual(first.updatedAt.getTime());
    expect(await repo.get(OTHER_TENANT_ID)).toBeNull();
  });

  it("the database refuses a reasoning level the contract does not have", async () => {
    await expect(
      tdb.pool.query("INSERT INTO llm_settings (tenant_id, default_model, default_reasoning) VALUES ($1, 'x', 'xhigh')", [OTHER_TENANT_ID]),
    ).rejects.toThrow(/reasoning_level/);
  });
});

describe("ProviderKeyRepository", () => {
  it("saves, replaces and removes a key per tenant and provider; statuses never carry key material", async () => {
    const keys = new ProviderKeyRepository(tdb.db);
    expect(await keys.listStatus(TEST_TENANT_ID)).toEqual([]);
    await keys.set(TEST_TENANT_ID, "gemini", encrypted("g1"));
    await keys.set(TEST_TENANT_ID, "anthropic", encrypted("a1"));
    const replaced = await keys.set(TEST_TENANT_ID, "gemini", encrypted("g2"));
    expect(replaced).toEqual({ provider: "gemini", updatedAt: expect.any(Date) });

    const status = await keys.listStatus(TEST_TENANT_ID);
    expect(status.map((s) => s.provider)).toEqual(["anthropic", "gemini"]);
    for (const s of status) expect(Object.keys(s).sort()).toEqual(["provider", "updatedAt"]);
    expect(JSON.stringify(status)).not.toContain("cipher-");

    expect((await keys.getEncrypted(TEST_TENANT_ID, "gemini"))!.ciphertext.toString()).toBe("cipher-g2");
    expect(await keys.getEncrypted(OTHER_TENANT_ID, "gemini")).toBeNull();
    expect(await keys.remove(TEST_TENANT_ID, "gemini")).toBe(true);
    expect(await keys.remove(TEST_TENANT_ID, "gemini")).toBe(false);
    expect((await keys.listStatus(TEST_TENANT_ID)).map((s) => s.provider)).toEqual(["anthropic"]);
  });

  it("the database holds keys only for anthropic and gemini", async () => {
    await expect(
      tdb.pool.query("INSERT INTO llm_provider_keys (tenant_id, provider, ciphertext, iv, auth_tag) VALUES ($1, 'openai', '\\x00', '\\x00', '\\x00')", [TEST_TENANT_ID]),
    ).rejects.toThrow(/llm_provider_keys_provider/);
  });
});
