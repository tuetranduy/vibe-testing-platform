import { pipeline } from "node:stream";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { assertValidObjectKey, buildObjectKey } from "./object-key";
import { type ArtifactStorage, createHashingStream, hashBuffer, normalizeTtl, StorageError, wrapStorageError } from "./storage";

export interface S3StorageOptions {
  bucket: string;
  /** Custom endpoint for S3-compatible servers (MinIO: http://localhost:9000). Omit for AWS. */
  endpoint?: string | undefined;
  /**
   * Endpoint that signed read URLs are presigned against, when the one this process uses isn't
   * reachable by whoever follows the URL (compose: the api talks to `http://s3:9000`, a host browser
   * needs `http://localhost:9000`). Must reach the same server and bucket. Default: `endpoint`.
   */
  publicEndpoint?: string | undefined;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** true for MinIO and most S3-compatible servers. */
  forcePathStyle: boolean;
  /** How long connecting to the store may take. Default 5 s. */
  connectionTimeoutMs?: number;
  /**
   * How long a request's socket may sit idle (nothing sent or received) before the request fails.
   * An idle limit, not a total one, so a large upload that keeps moving is never cut off. Default 30 s.
   */
  socketTimeoutMs?: number;
}

/** Multipart part size for streamed uploads (S3 minimum is 5 MiB). */
const PART_SIZE = 5 * 1024 * 1024;
const QUEUE_SIZE = 4;
const CONNECTION_TIMEOUT_MS = 5_000;
const SOCKET_TIMEOUT_MS = 30_000;

export function createS3Storage(opts: S3StorageOptions): ArtifactStorage {
  for (const k of ["bucket", "region", "accessKeyId", "secretAccessKey"] as const) {
    if (!opts[k]) throw new StorageError(`s3 storage: ${k} is required`, { operation: "config" });
  }
  const { bucket } = opts;
  const makeClient = (endpoint: string | undefined) =>
    new S3Client({
      region: opts.region,
      ...(endpoint ? { endpoint } : {}),
      forcePathStyle: opts.forcePathStyle,
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
      // Only send/validate flexible checksums when an operation requires them. The default
      // ("WHEN_SUPPORTED") uses aws-chunked trailer encoding that several S3-compatible servers
      // mishandle; integrity is covered by our own sha256.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      // Without these a store that stops answering holds a request (an upload, a retention delete)
      // forever. A timed-out attempt is retried like any network error, then fails.
      requestHandler: {
        connectionTimeout: opts.connectionTimeoutMs ?? CONNECTION_TIMEOUT_MS,
        socketTimeout: opts.socketTimeoutMs ?? SOCKET_TIMEOUT_MS,
      },
    });
  const client = makeClient(opts.endpoint);
  // SigV4 signs the Host header, so a URL for another host must be signed by a client configured
  // with that host (rewriting the URL afterwards would break the signature). Presigning is local
  // computation: this client never sends a request.
  const signingClient = opts.publicEndpoint ? makeClient(opts.publicEndpoint) : client;

  return {
    async ensureReady() {
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }));
        return;
      } catch {
        /* missing or not yet reachable: try to create it */
      }
      try {
        await client.send(new CreateBucketCommand({ Bucket: bucket }));
      } catch (err) {
        const name = (err as { name?: string }).name;
        if (name === "BucketAlreadyOwnedByYou" || name === "BucketAlreadyExists") return;
        throw wrapStorageError(err, "init", bucket);
      }
    },
    async put(input) {
      const objectKey = buildObjectKey(input);
      const Metadata = { sensitivity: input.sensitivity, "artifact-type": input.type };

      if (Buffer.isBuffer(input.body)) {
        const result = hashBuffer(input.body);
        try {
          await client.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: objectKey,
              Body: input.body,
              ContentLength: input.body.length,
              ContentType: input.contentType,
              Metadata,
            }),
          );
        } catch (err) {
          throw wrapStorageError(err, "put", objectKey);
        }
        return { objectKey, ...result };
      }

      // Stream of unknown length: hash while piping into a multipart-capable Upload.
      const source = input.body;
      const hasher = createHashingStream();
      let sourceError: Error | undefined;
      pipeline(source, hasher, (err) => {
        if (err) sourceError = err;
      });
      const upload = new Upload({
        client,
        params: { Bucket: bucket, Key: objectKey, Body: hasher, ContentType: input.contentType, Metadata },
        partSize: PART_SIZE,
        queueSize: QUEUE_SIZE,
        leavePartsOnError: false,
      });
      try {
        await upload.done();
      } catch (err) {
        source.destroy();
        hasher.destroy();
        throw wrapStorageError(sourceError ?? err, "put", objectKey);
      }
      const result = hasher.result();
      if (sourceError || !result) {
        throw wrapStorageError(sourceError ?? new Error("hash not finalized"), "put", objectKey);
      }
      return { objectKey, ...result };
    },

    async getSignedReadUrl(objectKey, ttlSeconds) {
      assertValidObjectKey(objectKey);
      const expiresIn = normalizeTtl(ttlSeconds);
      try {
        return await getSignedUrl(signingClient, new GetObjectCommand({ Bucket: bucket, Key: objectKey }), { expiresIn });
      } catch (err) {
        throw wrapStorageError(err, "sign", objectKey);
      }
    },

    async delete(objectKey) {
      assertValidObjectKey(objectKey);
      try {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }));
      } catch (err) {
        if ((err as { name?: string }).name === "NoSuchKey") return;
        throw wrapStorageError(err, "delete", objectKey);
      }
    },
  };
}
