import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, type EncryptedSecret } from "./secret-vault";

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
