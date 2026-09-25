import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { assertValidObjectKey, buildObjectKey } from "./object-key";
import {
  type ArtifactStorage,
  createHashingStream,
  InvalidArtifactKeyError,
  normalizeTtl,
  StorageError,
  toReadable,
  wrapStorageError,
} from "./storage";

export interface LocalStorageOptions {
  /** Directory all artifacts are written under. Created on first put. */
  rootDir: string;
  /**
   * Optional HTTP base URL (e.g. `http://localhost:3001/dev-artifacts`) that serves
   * `<publicBaseUrl>/<objectKey>`. When set, `signingKey` is required and
   * getSignedReadUrl returns `<publicBaseUrl>/<objectKey>?expires=<unix s>&signature=<hex>`
   * where `signature = HMAC-SHA256(signingKey, "<objectKey>\n<expires>")`. The serving route
   * must check it with `verifyLocalSignedUrl`.
   * When unset, getSignedReadUrl returns a plain `file://` URL (no expiry — dev only).
   */
  publicBaseUrl?: string;
  /** >= 32 bytes. */
  signingKey?: Buffer;
}

const MIN_SIGNING_KEY_BYTES = 32;

function sign(signingKey: Buffer, objectKey: string, expires: number): string {
  return createHmac("sha256", signingKey).update(`${objectKey}\n${expires}`).digest("hex");
}

/** Constant-time check of a signed local URL's `expires`/`signature` query values. */
export function verifyLocalSignedUrl(input: {
  signingKey: Buffer;
  objectKey: string;
  expires: number;
  signature: string;
  nowMs?: number;
}): boolean {
  const { signingKey, objectKey, expires, signature } = input;
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isInteger(expires) || expires * 1000 < nowMs) return false;
  if (!/^[0-9a-f]{64}$/.test(signature)) return false;
  const expected = Buffer.from(sign(signingKey, objectKey, expires), "hex");
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}

/**
 * Resolves an object key to an absolute path under rootDir. Validates the key shape and
 * double-checks that the resolved path cannot escape rootDir.
 */
export function resolveLocalObjectPath(rootDir: string, objectKey: string): string {
  assertValidObjectKey(objectKey);
  const root = resolve(rootDir);
  const full = resolve(root, objectKey);
  const rel = relative(root, full);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new InvalidArtifactKeyError(`object key escapes storage root: ${JSON.stringify(objectKey)}`);
  }
  return full;
}

/** Filesystem-backed ArtifactStorage. Development only — never use in production. */
export function createLocalStorage(opts: LocalStorageOptions): ArtifactStorage {
  const rootDir = resolve(opts.rootDir);
  const publicBaseUrl = opts.publicBaseUrl?.replace(/\/+$/, "");
  const signingKey = opts.signingKey;
  if (publicBaseUrl !== undefined) {
    if (!signingKey) {
      throw new StorageError("local storage: signingKey is required when publicBaseUrl is set", { operation: "config" });
    }
    if (signingKey.length < MIN_SIGNING_KEY_BYTES) {
      throw new StorageError(`local storage: signingKey must be at least ${MIN_SIGNING_KEY_BYTES} bytes`, {
        operation: "config",
      });
    }
  }

  return {
    async ensureReady() {
      try {
        await mkdir(rootDir, { recursive: true });
      } catch (err) {
        throw wrapStorageError(err, "init", rootDir);
      }
    },
    async put(input) {
      const objectKey = buildObjectKey(input);
      const finalPath = resolveLocalObjectPath(rootDir, objectKey);
      const tmpPath = `${finalPath}.${randomBytes(6).toString("hex")}.partial`;
      const hasher = createHashingStream();
      try {
        await mkdir(dirname(finalPath), { recursive: true });
        await pipeline(toReadable(input.body), hasher, createWriteStream(tmpPath, { flags: "wx" }));
        await rename(tmpPath, finalPath);
      } catch (err) {
        await rm(tmpPath, { force: true }).catch(() => undefined);
        throw wrapStorageError(err, "put", objectKey);
      }
      const result = hasher.result();
      if (!result) throw new StorageError("local storage: hash not finalized", { operation: "put", objectKey });
      return { objectKey, ...result };
    },

    async getSignedReadUrl(objectKey, ttlSeconds) {
      const path = resolveLocalObjectPath(rootDir, objectKey);
      const ttl = normalizeTtl(ttlSeconds);
      if (publicBaseUrl === undefined || !signingKey) return pathToFileURL(path).href;
      const expires = Math.floor(Date.now() / 1000) + ttl;
      const url = new URL(`${publicBaseUrl}/${objectKey}`);
      url.searchParams.set("expires", String(expires));
      url.searchParams.set("signature", sign(signingKey, objectKey, expires));
      return url.toString();
    },

    async delete(objectKey) {
      const path = resolveLocalObjectPath(rootDir, objectKey);
      try {
        await rm(path, { force: true });
      } catch (err) {
        throw wrapStorageError(err, "delete", objectKey);
      }
    },
  };
}
