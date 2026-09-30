import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decryptProfileSecret,
  decryptProviderKey,
  decryptSecret,
  encryptProfileSecret,
  encryptProviderKey,
  encryptSecret,
  type EncryptedSecret,
} from "./secret-vault";

const key = randomBytes(32);
const aad = { runId: "run_123", name: "PASSWORD" };

function flip(buf: Buffer, index = 0): Buffer {
  const copy = Buffer.from(buf);
  copy[index] = (copy[index] ?? 0) ^ 0x01;
  return copy;
}

describe("secret vault", () => {
  it("round-trips", () => {
    const enc = encryptSecret("hunter2-long", aad, key);
    expect(decryptSecret(enc, aad, key)).toBe("hunter2-long");
  });

  it("round-trips unicode and empty strings", () => {
    for (const plain of ["", "pässwörd ✓ 秘密"]) {
      expect(decryptSecret(encryptSecret(plain, aad, key), aad, key)).toBe(plain);
    }
  });

  it("uses a random 12-byte IV and a 16-byte tag; ciphertext differs per call", () => {
    const a = encryptSecret("same", aad, key);
    const b = encryptSecret("same", aad, key);
    expect(a.iv).toHaveLength(12);
    expect(a.authTag).toHaveLength(16);
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.ciphertext.toString("utf8")).not.toContain("same");
  });

  it("fails on tampered ciphertext", () => {
    const enc = encryptSecret("hunter2-long", aad, key);
    expect(() => decryptSecret({ ...enc, ciphertext: flip(enc.ciphertext) }, aad, key)).toThrow();
  });

  it("fails on tampered auth tag or IV", () => {
    const enc = encryptSecret("hunter2-long", aad, key);
    expect(() => decryptSecret({ ...enc, authTag: flip(enc.authTag) }, aad, key)).toThrow();
    expect(() => decryptSecret({ ...enc, iv: flip(enc.iv) }, aad, key)).toThrow();
  });

  it("fails when the runId in AAD differs", () => {
    const enc = encryptSecret("hunter2-long", aad, key);
    expect(() => decryptSecret(enc, { ...aad, runId: "run_456" }, key)).toThrow();
  });

  it("fails when the secret name in AAD differs", () => {
    const enc = encryptSecret("hunter2-long", aad, key);
    expect(() => decryptSecret(enc, { ...aad, name: "OTHER" }, key)).toThrow();
  });

  it("AAD encoding is unambiguous (runId/name boundary cannot shift)", () => {
    const enc = encryptSecret("x", { runId: "a:b", name: "c" }, key);
    expect(() => decryptSecret(enc, { runId: "a", name: "b:c" }, key)).toThrow();
  });

  it("fails with a different key", () => {
    const enc = encryptSecret("hunter2-long", aad, key);
    expect(() => decryptSecret(enc, aad, randomBytes(32))).toThrow();
  });

  it("requires a 32-byte key", () => {
    expect(() => encryptSecret("x", aad, randomBytes(16))).toThrow(/32/);
    expect(() => encryptSecret("x", aad, Buffer.alloc(0))).toThrow(/32/);
    const enc: EncryptedSecret = encryptSecret("x", aad, key);
    expect(() => decryptSecret(enc, aad, randomBytes(31))).toThrow(/32/);
  });

  it("rejects a malformed IV or tag length", () => {
    const enc = encryptSecret("x", aad, key);
    expect(() => decryptSecret({ ...enc, iv: enc.iv.subarray(0, 8) }, aad, key)).toThrow();
    expect(() => decryptSecret({ ...enc, authTag: enc.authTag.subarray(0, 4) }, aad, key)).toThrow();
  });
});

describe("provider key vault (Settings → AI providers)", () => {
  const owner = { tenantId: "t_default", provider: "anthropic" };
  const apiKey = "sk-ant-api03-Provider-Key-777";

  it("round-trips, and the ciphertext does not contain the key", () => {
    const enc = encryptProviderKey(apiKey, owner, key);
    expect(decryptProviderKey(enc, owner, key)).toBe(apiKey);
    expect(enc.iv).toHaveLength(12);
    expect(enc.authTag).toHaveLength(16);
    expect(enc.ciphertext.toString("utf8")).not.toContain("Provider-Key");
  });

  it("fails for another tenant or another provider", () => {
    const enc = encryptProviderKey(apiKey, owner, key);
    expect(() => decryptProviderKey(enc, { ...owner, tenantId: "t_other" }, key)).toThrow();
    expect(() => decryptProviderKey(enc, { ...owner, provider: "gemini" }, key)).toThrow();
  });

  it("never opens with a run secret's AAD, nor opens a run secret", () => {
    const providerKey = encryptProviderKey(apiKey, owner, key);
    expect(() => decryptSecret(providerKey, { runId: owner.tenantId, name: owner.provider }, key)).toThrow();
    expect(() => decryptSecret(providerKey, { runId: "llm-provider-key", name: owner.tenantId }, key)).toThrow();
    const runSecret = encryptSecret(apiKey, { runId: owner.tenantId, name: owner.provider }, key);
    expect(() => decryptProviderKey(runSecret, owner, key)).toThrow();
  });

  it("fails after SECRETS_ENCRYPTION_KEY is rotated", () => {
    const enc = encryptProviderKey(apiKey, owner, key);
    expect(() => decryptProviderKey(enc, owner, randomBytes(32))).toThrow();
  });
});

describe("credential profile secrets (V1.1)", () => {
  const key = Buffer.alloc(32, 7);
  const aad = { tenantId: "t_1", profileId: "cp_1", name: "password" };

  it("round-trips and binds the value to tenant, profile and name", () => {
    const enc = encryptProfileSecret("hunter2-long", aad, key);
    expect(decryptProfileSecret(enc, aad, key)).toBe("hunter2-long");
    expect(() => decryptProfileSecret(enc, { ...aad, tenantId: "t_2" }, key)).toThrow();
    expect(() => decryptProfileSecret(enc, { ...aad, profileId: "cp_2" }, key)).toThrow();
    expect(() => decryptProfileSecret(enc, { ...aad, name: "pin" }, key)).toThrow();
  });

  it("cannot be opened as a run secret (or the other way round)", () => {
    const enc = encryptProfileSecret("hunter2-long", aad, key);
    expect(() => decryptSecret(enc, { runId: "cp_1", name: "password" }, key)).toThrow();
    const run = encryptSecret("hunter2-long", { runId: "cp_1", name: "password" }, key);
    expect(() => decryptProfileSecret(run, aad, key)).toThrow();
  });
});
