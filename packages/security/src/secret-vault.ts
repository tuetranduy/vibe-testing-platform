import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type EncryptedSecret = { ciphertext: Buffer; iv: Buffer; authTag: Buffer };
export type SecretAad = { runId: string; name: string };

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function assertKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new Error(`Secret encryption key must be exactly ${KEY_BYTES} bytes (got ${key?.length ?? 0})`);
  }
}

// JSON array encoding keeps the (runId, name) boundary unambiguous: ("a:b","c") ≠ ("a","b:c").
const encodeAad = (aad: SecretAad): Buffer => Buffer.from(JSON.stringify([aad.runId, aad.name]), "utf8");

/** AES-256-GCM with a random 12-byte IV. The secret is bound to its run and name through the AAD. */
export function encryptSecret(plain: string, aad: SecretAad, key: Buffer): EncryptedSecret {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(encodeAad(aad));
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

/** Throws if the key, AAD, IV, tag or ciphertext do not match what was encrypted. */
export function decryptSecret(enc: EncryptedSecret, aad: SecretAad, key: Buffer): string {
  assertKey(key);
  if (enc.iv.length !== IV_BYTES) throw new Error(`Invalid IV length ${enc.iv.length}`);
  if (enc.authTag.length !== TAG_BYTES) throw new Error(`Invalid auth tag length ${enc.authTag.length}`);
  const decipher = createDecipheriv(ALGORITHM, key, enc.iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(encodeAad(aad));
  decipher.setAuthTag(enc.authTag);
  return Buffer.concat([decipher.update(enc.ciphertext), decipher.final()]).toString("utf8");
}
