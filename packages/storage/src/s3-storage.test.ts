import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { CreateBucketCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { beforeAll, describe, expect, it } from "vitest";
import { createS3Storage, InvalidArtifactKeyError, StorageError } from "./index";

/**
 * Runs against a real S3-compatible server. Gated on S3_TEST_ENDPOINT — see README.md
 * ("How to run S3 tests locally").
 */
const endpoint = process.env.S3_TEST_ENDPOINT;
const accessKeyId = process.env.S3_TEST_ACCESS_KEY_ID ?? "minioadmin";
const secretAccessKey = process.env.S3_TEST_SECRET_ACCESS_KEY ?? "minioadmin";
const bucket = process.env.S3_TEST_BUCKET ?? "artifacts";
const region = process.env.S3_TEST_REGION ?? "us-east-1";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!endpoint)("S3 storage (real S3-compatible server)", () => {
  const opts = { bucket, endpoint, region, accessKeyId, secretAccessKey, forcePathStyle: true };
  const storage = createS3Storage(opts);
  const tenantId = "t_s3test";
  const runId = `r_${randomUUID().replaceAll("-", "")}`;

  beforeAll(async () => {
    const client = new S3Client({ endpoint, region, forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } });
    try {
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name !== "BucketAlreadyOwnedByYou" && name !== "BucketAlreadyExists") throw err;
    } finally {
      client.destroy();
    }
  });

  it("puts a Buffer and the signed URL returns identical bytes", async () => {
    const body = Buffer.from(`hello from ${runId}`);
    const res = await storage.put({
      tenantId,
      runId,
      type: "SCREENSHOT",
      fileName: "before-add.png",
      body,
      contentType: "image/png",
      sensitivity: "STANDARD",
    });
    expect(res.objectKey).toMatch(new RegExp(`^tenants/${tenantId}/runs/${runId}/screenshots/before-add-[0-9a-f]{16}\\.png$`));
    expect(res).toMatchObject({ sha256: sha(body), bytes: body.length });

    const url = await storage.getSignedReadUrl(res.objectKey, 60);
    const resp = await fetch(url);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await resp.arrayBuffer())).toEqual(body);
  });

  it("streams a multi-part Readable of unknown length (hash computed while streaming)", async () => {
    // 12 MiB of non-uniform data -> forces a multipart upload (5 MiB parts).
    const chunk = (i: number) => Buffer.alloc(256 * 1024, i % 251);
    const count = 48;
    const expected = createHash("sha256");
    for (let i = 0; i < count; i++) expected.update(chunk(i));
    const body = Readable.from(
      (function* () {
        for (let i = 0; i < count; i++) yield chunk(i);
      })(),
    );
    const res = await storage.put({
      tenantId,
      runId,
      type: "TRACE",
      fileName: "trace.zip",
      body,
      contentType: "application/zip",
      sensitivity: "SECRET_BEARING",
    });
    expect(res.bytes).toBe(count * 256 * 1024);
    expect(res.sha256).toBe(expected.digest("hex"));

    const resp = await fetch(await storage.getSignedReadUrl(res.objectKey, 60));
    expect(resp.status).toBe(200);
    expect(sha(Buffer.from(await resp.arrayBuffer()))).toBe(res.sha256);

    const client = new S3Client({ endpoint, region, forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } });
    try {
      const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: res.objectKey }));
      expect(head.ContentLength).toBe(res.bytes);
      expect(head.Metadata?.sensitivity).toBe("SECRET_BEARING");
    } finally {
      client.destroy();
    }
  });

  it("signed URL expires", async () => {
    const { objectKey } = await storage.put({
      tenantId,
      runId,
      type: "VIDEO",
      fileName: "v.webm",
      body: Buffer.from("video"),
      contentType: "video/webm",
      sensitivity: "STANDARD",
    });
    const url = await storage.getSignedReadUrl(objectKey, 1);
    const control = await storage.getSignedReadUrl(objectKey, 60);
    expect(new URL(url).searchParams.get("X-Amz-Expires")).toBe("1");
    await sleep(2_100);
    // Same object, same signing path, still valid -> proves the failure below is the expiry.
    expect((await fetch(control)).status).toBe(200);
    const resp = await fetch(url);
    // AWS S3 and MinIO answer 403 AccessDenied ("Request has expired"). rclone's gofakes3
    // (used for local verification, see README) answers AccessDenied with HTTP 400.
    expect(resp.ok).toBe(false);
    expect([400, 403]).toContain(resp.status);
    expect(await resp.text()).toContain("<Code>AccessDenied</Code>");
  });

  it("clamps ttl to 300 seconds", async () => {
    const url = await storage.getSignedReadUrl(`tenants/${tenantId}/runs/${runId}/videos/x-0123456789abcdef.webm`, 3600);
    expect(new URL(url).searchParams.get("X-Amz-Expires")).toBe("300");
  });

  it("delete removes the object and is idempotent", async () => {
    const { objectKey } = await storage.put({
      tenantId,
      runId,
      type: "GENERATED_TEST",
      fileName: "cart.spec.ts",
      body: Buffer.from("test('x', () => {})"),
      contentType: "text/plain",
      sensitivity: "STANDARD",
    });
    await storage.delete(objectKey);
    const resp = await fetch(await storage.getSignedReadUrl(objectKey, 30));
    expect(resp.status).toBe(404);
    await expect(storage.delete(objectKey)).resolves.toBeUndefined();
  });

  it("rejects malformed object keys", async () => {
    await expect(storage.getSignedReadUrl("../../etc/passwd", 10)).rejects.toThrow(InvalidArtifactKeyError);
    await expect(storage.delete("tenants/x/../y")).rejects.toThrow(InvalidArtifactKeyError);
  });

  it("wraps SDK errors in StorageError (missing bucket)", async () => {
    const broken = createS3Storage({ ...opts, bucket: `missing-${randomUUID()}` });
    const err = await broken
      .put({
        tenantId,
        runId,
        type: "SCREENSHOT",
        fileName: "a.png",
        body: Buffer.from("x"),
        contentType: "image/png",
        sensitivity: "STANDARD",
      })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(StorageError);
    expect((err as StorageError).operation).toBe("put");
    expect((err as StorageError).cause).toBeDefined();
  });

  it("wraps SDK errors in StorageError (bad credentials, streamed body)", async () => {
    const broken = createS3Storage({ ...opts, secretAccessKey: "definitely-wrong-secret" });
    const err = await broken
      .put({
        tenantId,
        runId,
        type: "SCREENSHOT",
        fileName: "a.png",
        body: Readable.from([Buffer.from("x")]),
        contentType: "image/png",
        sensitivity: "STANDARD",
      })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(StorageError);
  });

  it("wraps a failing source stream in StorageError", async () => {
    const body = new Readable({
      read() {
        this.destroy(new Error("source exploded"));
      },
    });
    const err = await storage
      .put({ tenantId, runId, type: "VIDEO", fileName: "v.webm", body, contentType: "video/webm", sensitivity: "STANDARD" })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(StorageError);
  });
});
