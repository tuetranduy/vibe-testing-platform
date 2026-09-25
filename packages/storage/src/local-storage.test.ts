import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalStorage, InvalidArtifactKeyError, StorageError, verifyLocalSignedUrl } from "./index";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const base = { tenantId: "t_1", runId: "r_1", contentType: "image/png", sensitivity: "STANDARD" } as const;

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
}

describe("local storage", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "artifact-local-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("ensureReady creates the root directory and is idempotent", async () => {
    const dir = join(root, "nested", "store");
    const storage = createLocalStorage({ rootDir: dir });
    await storage.ensureReady();
    await storage.ensureReady();
    expect((await stat(dir)).isDirectory()).toBe(true);
  });

  it("puts a Buffer under rootDir and returns key, sha256 and bytes", async () => {
    const storage = createLocalStorage({ rootDir: root });
    const body = Buffer.from("png-bytes");
    const res = await storage.put({ ...base, type: "SCREENSHOT", fileName: "before-add.png", body });
    expect(res.objectKey).toMatch(/^tenants\/t_1\/runs\/r_1\/screenshots\/before-add-[0-9a-f]{16}\.png$/);
    expect(res.sha256).toBe(sha(body));
    expect(res.bytes).toBe(body.length);
    const onDisk = resolve(root, res.objectKey);
    expect(onDisk.startsWith(resolve(root) + sep)).toBe(true);
    expect(await readFile(onDisk)).toEqual(body);
    // no temp files left behind
    expect(await listFiles(root)).toEqual([onDisk]);
  });

  it("streams a Readable, hashing while writing", async () => {
    const storage = createLocalStorage({ rootDir: root });
    const chunks = Array.from({ length: 50 }, (_, i) => Buffer.alloc(100_000, i));
    const all = Buffer.concat(chunks);
    const res = await storage.put({ ...base, type: "TRACE", fileName: "trace.zip", body: Readable.from(chunks) });
    expect(res.bytes).toBe(all.length);
    expect(res.sha256).toBe(sha(all));
    expect(sha(await readFile(join(root, res.objectKey)))).toBe(sha(all));
  });

  it("handles an empty body", async () => {
    const storage = createLocalStorage({ rootDir: root });
    const res = await storage.put({ ...base, type: "SCREENSHOT", fileName: "empty.png", body: Buffer.alloc(0) });
    expect(res.bytes).toBe(0);
    expect(res.sha256).toBe(sha(Buffer.alloc(0)));
  });

  it("keeps sanitized file names inside rootDir", async () => {
    const storage = createLocalStorage({ rootDir: root });
    const res = await storage.put({ ...base, type: "SCREENSHOT", fileName: "../../../escape.png", body: Buffer.from("x") });
    expect(res.objectKey.startsWith("tenants/t_1/runs/r_1/screenshots/escape-")).toBe(true);
    const files = await listFiles(root);
    expect(files).toHaveLength(1);
    expect(files[0]!.startsWith(resolve(root) + sep)).toBe(true);
  });

  it("rejects invalid tenant/run ids", async () => {
    const storage = createLocalStorage({ rootDir: root });
    await expect(
      storage.put({ ...base, tenantId: "../x", type: "SCREENSHOT", fileName: "a.png", body: Buffer.from("x") }),
    ).rejects.toThrow(InvalidArtifactKeyError);
  });

  it("wraps a failing source stream in StorageError and leaves no partial file", async () => {
    const storage = createLocalStorage({ rootDir: root });
    const body = new Readable({
      read() {
        this.push(Buffer.from("partial"));
        this.destroy(new Error("source exploded"));
      },
    });
    const err = await storage
      .put({ ...base, type: "VIDEO", fileName: "v.webm", body })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(StorageError);
    expect((err as StorageError).operation).toBe("put");
    expect(((err as StorageError).cause as Error).message).toBe("source exploded");
    expect(await listFiles(root)).toEqual([]);
  });

  it("getSignedReadUrl returns a file:// URL pointing at the stored file by default", async () => {
    const storage = createLocalStorage({ rootDir: root });
    const body = Buffer.from("abc");
    const { objectKey } = await storage.put({ ...base, type: "SCREENSHOT", fileName: "a.png", body });
    const url = await storage.getSignedReadUrl(objectKey, 60);
    expect(url.startsWith("file://")).toBe(true);
    expect(await readFile(fileURLToPath(url))).toEqual(body);
  });

  it("getSignedReadUrl returns an HMAC-signed publicBaseUrl URL with expires", async () => {
    const signingKey = Buffer.alloc(32, 9);
    const storage = createLocalStorage({ rootDir: root, publicBaseUrl: "http://localhost:3001/dev-artifacts/", signingKey });
    const objectKey = "tenants/t_1/runs/r_1/screenshots/a-0123456789abcdef.png";
    const now = Date.now();
    const url = new URL(await storage.getSignedReadUrl(objectKey, 60));
    expect(`${url.origin}${url.pathname}`).toBe(`http://localhost:3001/dev-artifacts/${objectKey}`);
    const expires = Number(url.searchParams.get("expires"));
    expect(expires).toBeGreaterThanOrEqual(Math.floor(now / 1000) + 59);
    expect(expires).toBeLessThanOrEqual(Math.floor(now / 1000) + 61);
    expect(url.searchParams.get("signature")).toMatch(/^[0-9a-f]{64}$/);

    const sig = url.searchParams.get("signature")!;
    expect(verifyLocalSignedUrl({ signingKey, objectKey, expires, signature: sig })).toBe(true);
    // tampered key / signature / expires, wrong key, expired
    expect(verifyLocalSignedUrl({ signingKey, objectKey: objectKey.replace("t_1", "t_2"), expires, signature: sig })).toBe(false);
    expect(verifyLocalSignedUrl({ signingKey, objectKey, expires: expires + 1, signature: sig })).toBe(false);
    expect(verifyLocalSignedUrl({ signingKey, objectKey, expires, signature: "00".repeat(32) })).toBe(false);
    expect(verifyLocalSignedUrl({ signingKey, objectKey, expires, signature: "zz" })).toBe(false);
    expect(verifyLocalSignedUrl({ signingKey: Buffer.alloc(32, 1), objectKey, expires, signature: sig })).toBe(false);
    expect(verifyLocalSignedUrl({ signingKey, objectKey, expires, signature: sig, nowMs: (expires + 1) * 1000 })).toBe(false);
  });

  it("clamps the signed URL ttl to 300 seconds", async () => {
    const storage = createLocalStorage({ rootDir: root, publicBaseUrl: "http://h/a", signingKey: Buffer.alloc(32, 2) });
    const url = new URL(await storage.getSignedReadUrl("tenants/t/runs/r/traces/a-0123456789abcdef.zip", 86_400));
    expect(Number(url.searchParams.get("expires"))).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 300);
  });

  it("requires signingKey when publicBaseUrl is set", () => {
    expect(() => createLocalStorage({ rootDir: root, publicBaseUrl: "http://h/a" })).toThrow(StorageError);
    expect(() => createLocalStorage({ rootDir: root, publicBaseUrl: "http://h/a", signingKey: Buffer.alloc(8) })).toThrow(
      /at least 32 bytes/,
    );
  });

  it("delete removes the file and is a no-op when missing", async () => {
    const storage = createLocalStorage({ rootDir: root });
    const { objectKey } = await storage.put({ ...base, type: "SCREENSHOT", fileName: "a.png", body: Buffer.from("x") });
    await storage.delete(objectKey);
    await expect(stat(join(root, objectKey))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(storage.delete(objectKey)).resolves.toBeUndefined();
  });

  it.each([
    "../outside.txt",
    "tenants/t_1/runs/r_1/screenshots/../../../../../outside.txt",
    "/etc/passwd",
    "tenants/t_1/runs/r_1/screenshots/a/../../x.png",
  ])("refuses object keys that could escape rootDir: %j", async (objectKey) => {
    const storage = createLocalStorage({ rootDir: join(root, "store") });
    await writeFile(join(root, "outside.txt"), "keep me");
    await expect(storage.delete(objectKey)).rejects.toThrow(InvalidArtifactKeyError);
    await expect(storage.getSignedReadUrl(objectKey, 10)).rejects.toThrow(InvalidArtifactKeyError);
    expect(await readFile(join(root, "outside.txt"), "utf8")).toBe("keep me");
  });
});
