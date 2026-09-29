import { createHash, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * Password hashing for user accounts (V1.1 F1): scrypt with a random 16-byte salt and a 64-byte key,
 * stored as `scrypt$<N>$<r>$<p>$<salt b64>$<hash b64>` so the parameters can be raised later without
 * invalidating existing hashes.
 */

const KEY_BYTES = 64;
const SALT_BYTES = 16;
const DEFAULTS = { N: 2 ** 15, r: 8, p: 1 };
/** scrypt needs 128·N·r bytes; leave room above N=2^15 (32 MiB). */
const MAX_MEM = 256 * 1024 * 1024;

type Params = typeof DEFAULTS;

function derive(password: string, salt: Buffer, params: Params): Promise<Buffer> {
  const options: ScryptOptions = { N: params.N, r: params.r, p: params.p, maxmem: MAX_MEM };
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFC"), salt, KEY_BYTES, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string, params: Partial<Params> = {}): Promise<string> {
  const p = { ...DEFAULTS, ...params };
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, p);
  return ["scrypt", p.N, p.r, p.p, salt.toString("base64"), key.toString("base64")].join("$");
}

function parse(stored: string): { params: Params; salt: Buffer; key: Buffer } | null {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [N, r, p] = parts.slice(1, 4).map((x) => (/^\d{1,9}$/.test(x!) ? Number(x) : NaN));
  if (!N || !r || !p || N < 2 || (N & (N - 1)) !== 0 || N > 2 ** 20 || r > 32 || p > 16) return null;
  const salt = Buffer.from(parts[4]!, "base64");
  const key = Buffer.from(parts[5]!, "base64");
  if (salt.length < 8 || key.length !== KEY_BYTES) return null;
  return { params: { N, r, p }, salt, key };
}

let dummy: Promise<string> | undefined;

/**
 * True when `password` matches `stored`. `stored = null` (an unknown user) still costs one scrypt at the
 * default parameters, so the response time does not tell which accounts exist. A malformed hash is false.
 */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (stored === null) {
    dummy ??= hashPassword(randomBytes(16).toString("hex"));
    const parsed = parse(await dummy)!;
    await derive(password, parsed.salt, parsed.params);
    return false;
  }
  const parsed = parse(stored);
  if (!parsed) return false;
  const key = await derive(password, parsed.salt, parsed.params);
  return timingSafeEqual(key, parsed.key);
}

/** A new session token: 32 random bytes, base64url. Only its hash is stored. */
export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** SHA-256 of a session token (the stored lookup key). */
export function sessionTokenHash(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}
