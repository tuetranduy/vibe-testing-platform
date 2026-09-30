import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type EncryptedSecret = { ciphertext: Buffer; iv: Buffer; authTag: Buffer };
export type SecretAad = { runId: string; name: string };
/** A tenant's saved API key for one model provider (Settings → AI providers). */
export type ProviderKeyAad = { tenantId: string; provider: string };
/** One value of a saved credential profile (V1.1 F4). */
export type ProfileSecretAad = { tenantId: string; profileId: string; name: string };

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
// A three-element tag can never equal a run secret's two-element [runId, name].
const encodeProviderKeyAad = (aad: ProviderKeyAad): Buffer =>
  Buffer.from(JSON.stringify(["llm-provider-key", aad.tenantId, aad.provider]), "utf8");
// Four elements, tagged: never equal to a run secret's or a provider key's AAD.
const encodeProfileSecretAad = (aad: ProfileSecretAad): Buffer =>
  Buffer.from(JSON.stringify(["credential-profile", aad.tenantId, aad.profileId, aad.name]), "utf8");

/** AES-256-GCM with a random 12-byte IV. The secret is bound to its run and name through the AAD. */
export function encryptSecret(plain: string, aad: SecretAad, key: Buffer): EncryptedSecret {
  return encrypt(plain, encodeAad(aad), key);
}

function encrypt(plain: string, aad: Buffer, key: Buffer): EncryptedSecret {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

/** Throws if the key, AAD, IV, tag or ciphertext do not match what was encrypted. */
export function decryptSecret(enc: EncryptedSecret, aad: SecretAad, key: Buffer): string {
  return decrypt(enc, encodeAad(aad), key);
}

function decrypt(enc: EncryptedSecret, aad: Buffer, key: Buffer): string {
  assertKey(key);
  if (enc.iv.length !== IV_BYTES) throw new Error(`Invalid IV length ${enc.iv.length}`);
  if (enc.authTag.length !== TAG_BYTES) throw new Error(`Invalid auth tag length ${enc.authTag.length}`);
  const decipher = createDecipheriv(ALGORITHM, key, enc.iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(aad);
  decipher.setAuthTag(enc.authTag);
  return Buffer.concat([decipher.update(enc.ciphertext), decipher.final()]).toString("utf8");
}

/** A provider key is bound to its tenant and provider through the AAD. */
export function encryptProviderKey(plain: string, aad: ProviderKeyAad, key: Buffer): EncryptedSecret {
  return encrypt(plain, encodeProviderKeyAad(aad), key);
}

/** Throws if the saved key cannot be opened, including after SECRETS_ENCRYPTION_KEY rotation. */
export function decryptProviderKey(enc: EncryptedSecret, aad: ProviderKeyAad, key: Buffer): string {
  return decrypt(enc, encodeProviderKeyAad(aad), key);
}

/** A saved credential value is bound to its tenant, profile and name through the AAD. */
export function encryptProfileSecret(plain: string, aad: ProfileSecretAad, key: Buffer): EncryptedSecret {
  return encrypt(plain, encodeProfileSecretAad(aad), key);
}

/** Throws if the value cannot be opened (wrong tenant, profile or name, a rotated key, tampering). */
export function decryptProfileSecret(enc: EncryptedSecret, aad: ProfileSecretAad, key: Buffer): string {
  return decrypt(enc, encodeProfileSecretAad(aad), key);
}
