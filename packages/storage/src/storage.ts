import { createHash } from "node:crypto";
import { Readable, Transform, type TransformCallback } from "node:stream";
import type { ArtifactSensitivity, ArtifactType } from "@platform/contracts";

/** Signed read URLs never live longer than this. Larger requested TTLs are clamped (not rejected). */
export const MAX_SIGNED_URL_TTL_SECONDS = 300;

export interface PutArtifactInput {
  tenantId: string;
  runId: string;
  type: ArtifactType;
  /** Original file name; only used (sanitized) as a readable prefix of the object key. */
  fileName: string;
  body: Buffer | Readable;
  contentType: string;
  sensitivity: ArtifactSensitivity;
}

export interface PutArtifactResult {
  objectKey: string;
  /** Lower-case hex sha256 of the stored bytes, computed while streaming. */
  sha256: string;
  bytes: number;
}

export interface ArtifactStorage {
  put(input: PutArtifactInput): Promise<PutArtifactResult>;
  /** `ttlSeconds` must be >= 1; values above MAX_SIGNED_URL_TTL_SECONDS are clamped. */
  getSignedReadUrl(objectKey: string, ttlSeconds: number): Promise<string>;
  /** Idempotent: deleting a missing object is not an error. */
  delete(objectKey: string): Promise<void>;
}

export type StorageOperation = "put" | "sign" | "delete" | "config";

/**
 * Infrastructure failure talking to the artifact store (S3 SDK error, filesystem error,
 * broken source stream) or invalid storage configuration. The worker maps this to
 * error category STORAGE.
 */
export class StorageError extends Error {
  readonly operation: StorageOperation;
  readonly objectKey: string | undefined;

  constructor(message: string, opts: { operation: StorageOperation; objectKey?: string; cause?: unknown }) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "StorageError";
    this.operation = opts.operation;
    this.objectKey = opts.objectKey;
  }
}

/**
 * Caller bug: invalid tenantId/runId/type, or an object key that was not produced by
 * buildObjectKey (e.g. contains `..`). Deliberately NOT a StorageError.
 */
export class InvalidArtifactKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidArtifactKeyError";
  }
}

export function wrapStorageError(
  err: unknown,
  operation: StorageOperation,
  objectKey: string | undefined,
): StorageError | InvalidArtifactKeyError {
  if (err instanceof StorageError || err instanceof InvalidArtifactKeyError) return err;
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return new StorageError(`artifact storage ${operation} failed${objectKey ? ` for ${objectKey}` : ""}: ${detail}`, {
    operation,
    ...(objectKey === undefined ? {} : { objectKey }),
    cause: err,
  });
}

/** Floors to whole seconds, clamps to MAX_SIGNED_URL_TTL_SECONDS; throws RangeError for < 1 or non-finite. */
export function normalizeTtl(ttlSeconds: number): number {
  if (!Number.isFinite(ttlSeconds)) throw new RangeError(`ttlSeconds must be a finite number, got ${ttlSeconds}`);
  const ttl = Math.floor(ttlSeconds);
  if (ttl < 1) throw new RangeError(`ttlSeconds must be >= 1, got ${ttlSeconds}`);
  return Math.min(ttl, MAX_SIGNED_URL_TTL_SECONDS);
}

export interface HashingStream extends Transform {
  /** sha256 + byte count once the stream has flushed; undefined before that. */
  result(): { sha256: string; bytes: number } | undefined;
}

/** Pass-through Transform that hashes and counts bytes as they flow to the destination. */
export function createHashingStream(): HashingStream {
  const hash = createHash("sha256");
  let bytes = 0;
  let done: { sha256: string; bytes: number } | undefined;
  const stream = new Transform({
    transform(chunk: Buffer | string, _enc: BufferEncoding, cb: TransformCallback) {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      hash.update(buf);
      bytes += buf.length;
      cb(null, buf);
    },
    flush(cb: TransformCallback) {
      done = { sha256: hash.digest("hex"), bytes };
      cb();
    },
  }) as HashingStream;
  stream.result = () => done;
  return stream;
}

export function hashBuffer(body: Buffer): { sha256: string; bytes: number } {
  return { sha256: createHash("sha256").update(body).digest("hex"), bytes: body.length };
}

export function toReadable(body: Buffer | Readable): Readable {
  return Buffer.isBuffer(body) ? Readable.from([body]) : body;
}
