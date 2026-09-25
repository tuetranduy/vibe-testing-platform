import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createArtifactStorage,
  createHashingStream,
  MAX_SIGNED_URL_TTL_SECONDS,
  normalizeTtl,
  StorageError,
} from "./index";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe("createHashingStream", () => {
  it("passes chunks through unchanged and reports sha256 + bytes at end", async () => {
    const chunks = [Buffer.from("hello "), Buffer.from("streaming "), Buffer.from("world")];
    const hasher = createHashingStream();
    const seen: Buffer[] = [];
    let digestSeenBeforeEnd: string | undefined = "unset";
    await pipeline(
      Readable.from(chunks),
      hasher,
      new Writable({
        write(chunk: Buffer, _enc, cb) {
          seen.push(chunk);
          // Digest is only available once the stream has ended — proves it is incremental.
          if (seen.length === 1) digestSeenBeforeEnd = hasher.result()?.sha256;
          cb();
        },
      }),
    );
    expect(Buffer.concat(seen).toString()).toBe("hello streaming world");
    expect(seen.length).toBe(3);
    expect(digestSeenBeforeEnd).toBeUndefined();
    expect(hasher.result()).toEqual({ sha256: sha(Buffer.concat(chunks)), bytes: 21 });
  });

  it("hashes a large stream chunk-by-chunk without holding it all", async () => {
    const chunk = Buffer.alloc(64 * 1024, 7);
    const count = 160; // 10 MiB
    const expected = createHash("sha256");
    for (let i = 0; i < count; i++) expected.update(chunk);
    let maxChunk = 0;
    const hasher = createHashingStream();
    await pipeline(
      Readable.from(
        (function* () {
          for (let i = 0; i < count; i++) yield chunk;
        })(),
      ),
      hasher,
      new Writable({
        highWaterMark: 1,
        write(c: Buffer, _e, cb) {
          maxChunk = Math.max(maxChunk, c.length);
          setImmediate(cb);
        },
      }),
    );
    expect(maxChunk).toBe(chunk.length);
    expect(hasher.result()).toEqual({ sha256: expected.digest("hex"), bytes: chunk.length * count });
  });
});

describe("normalizeTtl", () => {
  it("clamps ttl above the maximum to MAX_SIGNED_URL_TTL_SECONDS", () => {
    expect(MAX_SIGNED_URL_TTL_SECONDS).toBe(300);
    expect(normalizeTtl(3600)).toBe(300);
    expect(normalizeTtl(300)).toBe(300);
    expect(normalizeTtl(60)).toBe(60);
    expect(normalizeTtl(1)).toBe(1);
    expect(normalizeTtl(1.7)).toBe(1);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.5])("rejects ttl %s", (ttl) => {
    expect(() => normalizeTtl(ttl)).toThrow(RangeError);
  });
});

describe("createArtifactStorage", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "artifact-factory-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates local storage when ARTIFACT_STORAGE_TYPE=local", async () => {
    const storage = createArtifactStorage({
      ARTIFACT_STORAGE_TYPE: "local",
      ARTIFACT_BUCKET: "artifacts",
      ARTIFACT_LOCAL_DIR: root,
    });
    const body = Buffer.from("factory");
    const res = await storage.put({
      tenantId: "t_1",
      runId: "r_1",
      type: "GENERATED_TEST",
      fileName: "cart.spec.ts",
      body,
      contentType: "text/plain",
      sensitivity: "STANDARD",
    });
    expect(await readFile(join(root, res.objectKey))).toEqual(body);
    expect(await storage.getSignedReadUrl(res.objectKey, 60)).toMatch(/^file:\/\//);
  });

  it("passes local publicBaseUrl/signingKey overrides", async () => {
    const storage = createArtifactStorage(
      { ARTIFACT_STORAGE_TYPE: "local", ARTIFACT_LOCAL_DIR: root },
      { localPublicBaseUrl: "http://localhost:3001/dev-artifacts", localSigningKey: Buffer.alloc(32, 1) },
    );
    const url = await storage.getSignedReadUrl("tenants/t/runs/r/traces/a-0123456789abcdef.zip", 60);
    expect(url).toMatch(/^http:\/\/localhost:3001\/dev-artifacts\/tenants\/t\/runs\/r\/traces\/a-0123456789abcdef\.zip\?/);
  });

  it("creates S3 storage (no network until used) with string or boolean S3_FORCE_PATH_STYLE", async () => {
    for (const forcePathStyle of ["true", "false", true, false] as const) {
      const storage = createArtifactStorage({
        ARTIFACT_STORAGE_TYPE: "s3",
        ARTIFACT_BUCKET: "artifacts",
        S3_ENDPOINT: "http://localhost:9000",
        S3_REGION: "us-east-1",
        S3_ACCESS_KEY_ID: "minioadmin",
        S3_SECRET_ACCESS_KEY: "minioadmin",
        S3_FORCE_PATH_STYLE: forcePathStyle,
      });
      const url = await storage.getSignedReadUrl("tenants/t/runs/r/videos/v-0123456789abcdef.webm", 60);
      const u = new URL(url);
      if (forcePathStyle === true || forcePathStyle === "true") {
        expect(u.host).toBe("localhost:9000");
        expect(u.pathname).toBe("/artifacts/tenants/t/runs/r/videos/v-0123456789abcdef.webm");
      } else {
        expect(u.host).toBe("artifacts.localhost:9000");
      }
      expect(u.searchParams.get("X-Amz-Expires")).toBe("60");
    }
  });

  it("defaults region to us-east-1 and path-style to true", async () => {
    const storage = createArtifactStorage({
      ARTIFACT_STORAGE_TYPE: "s3",
      ARTIFACT_BUCKET: "artifacts",
      S3_ENDPOINT: "http://localhost:9000",
      S3_ACCESS_KEY_ID: "k",
      S3_SECRET_ACCESS_KEY: "s",
    });
    const u = new URL(await storage.getSignedReadUrl("tenants/t/runs/r/videos/v-0123456789abcdef.webm", 10));
    expect(u.pathname.startsWith("/artifacts/")).toBe(true);
    expect(u.searchParams.get("X-Amz-Credential")).toContain("/us-east-1/s3/aws4_request");
  });

  it.each([
    [{ ARTIFACT_STORAGE_TYPE: "s3", S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: "s" }, /ARTIFACT_BUCKET/],
    [{ ARTIFACT_STORAGE_TYPE: "s3", ARTIFACT_BUCKET: "b", S3_SECRET_ACCESS_KEY: "s" }, /S3_ACCESS_KEY_ID/],
    [{ ARTIFACT_STORAGE_TYPE: "s3", ARTIFACT_BUCKET: "b", S3_ACCESS_KEY_ID: "k" }, /S3_SECRET_ACCESS_KEY/],
    [{ ARTIFACT_STORAGE_TYPE: "ftp" }, /ARTIFACT_STORAGE_TYPE/],
    [{}, /ARTIFACT_STORAGE_TYPE/],
  ])("rejects invalid config %j", (config, message) => {
    expect(() => createArtifactStorage(config as never)).toThrow(StorageError);
    expect(() => createArtifactStorage(config as never)).toThrow(message);
  });

  it("uses ./.artifacts when ARTIFACT_LOCAL_DIR is missing", () => {
    expect(() => createArtifactStorage({ ARTIFACT_STORAGE_TYPE: "local" })).not.toThrow();
  });
});

describe("StorageError", () => {
  it("carries operation, objectKey and cause", () => {
    const cause = new Error("boom");
    const err = new StorageError("put failed", { operation: "put", objectKey: "k", cause });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("StorageError");
    expect(err.operation).toBe("put");
    expect(err.objectKey).toBe("k");
    expect(err.cause).toBe(cause);
  });
});
