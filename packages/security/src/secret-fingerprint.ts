import { createHmac } from "node:crypto";

/**
 * An HMAC of a run secret's value (keyed with SECRETS_ENCRYPTION_KEY), stored next to its ciphertext at creation.
 * It was used to find the value in text the API received later (KI-022); since secrets are no longer redacted
 * (2026-10-07) nothing reads it, and it identifies a value without revealing it. The byte length is not an extra
 * leak: AES-GCM ciphertext has the plaintext's length.
 */

const DOMAIN = "run-secret-fingerprint\0";

export type SecretFingerprint = { digest: Buffer; bytes: number };

export function secretFingerprint(plain: string, key: Buffer): SecretFingerprint {
  const bytes = Buffer.byteLength(plain, "utf8");
  return { digest: hmac(key, Buffer.from(plain, "utf8")), bytes };
}

function hmac(key: Buffer, data: Buffer): Buffer {
  return createHmac("sha256", key).update(DOMAIN).update(data).digest();
}
