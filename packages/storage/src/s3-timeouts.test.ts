import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createS3Storage, StorageError } from "./index";
import { buildObjectKey } from "./object-key";

/** An S3 endpoint that accepts connections and never answers: a hung store. */
let server: Server;
let endpoint: string;
const sockets = new Set<Socket>();
beforeAll(async () => {
  server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
});

describe("S3 storage against a store that never answers", () => {
  it("fails a request whose socket stays idle for socketTimeoutMs instead of waiting forever", async () => {
    const storage = createS3Storage({
      bucket: "artifacts",
      endpoint,
      region: "us-east-1",
      accessKeyId: "key",
      secretAccessKey: "secret",
      forcePathStyle: true,
      socketTimeoutMs: 200,
    });
    const key = buildObjectKey({ tenantId: "t_1", runId: "run_1", type: "SCREENSHOT", fileName: "a.png" });
    const started = Date.now();
    await expect(storage.delete(key)).rejects.toBeInstanceOf(StorageError);
    // Three attempts (the SDK retries a timeout) of 200 ms each, plus backoff.
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 15_000);
});
