import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ArtifactRepository } from "@platform/db";
import { createLocalStorage, resolveLocalObjectPath, type ArtifactStorage } from "@platform/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { silentLogger } from "./deps";
import { createRerunEvidenceStore, loggedSpawn } from "./rerun";
import { createHarness, seedRun, type WorkerHarness } from "./test-support";

let h: WorkerHarness;
let dir: string;
beforeAll(async () => {
  h = await createHarness();
  dir = mkdtempSync(path.join(os.tmpdir(), "worker-rerun-evidence-"));
});
afterAll(async () => {
  await h?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date("2026-09-26T10:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const config = { artifactRetentionDays: 30, secretArtifactRetentionDays: 7 };
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe("createRerunEvidenceStore (Task 17, Step 5)", () => {
  it("stores each file and its artifacts row: SHA-256, size, type, sensitivity, expiry by retention", async () => {
    const run = await seedRun(h);
    const storage = createLocalStorage({ rootDir: dir });
    const store = createRerunEvidenceStore({ db: h.tdb.db, storage, config, now: () => NOW }, { runId: run.id, tenantId: run.tenantId });
    const trace = Buffer.from("scrubbed-trace-zip");
    const video = Buffer.from("webm");

    const a = await store.save({ type: "TRACE", fileName: "trace.zip", body: trace, contentType: "application/zip", sha256: sha256(trace), sensitivity: "SECRET_BEARING" });
    const b = await store.save({ type: "VIDEO", fileName: "video.webm", body: video, contentType: "video/webm", sha256: sha256(video), sensitivity: "STANDARD" });

    const rows = new Map((await new ArtifactRepository(h.tdb.db).listByRun(run.id)).map((r) => [r.id, r]));
    expect(rows.get(a.artifactId)).toMatchObject({ type: "TRACE", contentType: "application/zip", sensitivity: "SECRET_BEARING", sha256: sha256(trace), bytes: trace.length, expiresAt: new Date(NOW.getTime() + 7 * DAY) });
    expect(rows.get(b.artifactId)).toMatchObject({ type: "VIDEO", sensitivity: "STANDARD", expiresAt: new Date(NOW.getTime() + 30 * DAY) });
    expect(rows.get(a.artifactId)!.objectKey).toMatch(new RegExp(`^tenants/${run.tenantId}/runs/${run.id}/traces/trace-[0-9a-f]{16}\\.zip$`));
    expect(existsSync(resolveLocalObjectPath(dir, rows.get(a.artifactId)!.objectKey))).toBe(true);
  });

  it("stored bytes that do not match the collector's SHA-256 → the object is removed, no row, the error propagates", async () => {
    const run = await seedRun(h);
    const deleted: string[] = [];
    const storage: ArtifactStorage = {
      put: async () => ({ objectKey: `tenants/${run.tenantId}/runs/${run.id}/traces/trace-0000000000000000.zip`, sha256: "f".repeat(64), bytes: 1 }),
      delete: async (k) => void deleted.push(k),
      getSignedReadUrl: async () => "",
      ensureReady: async () => {},
    };
    const store = createRerunEvidenceStore({ db: h.tdb.db, storage, config }, { runId: run.id, tenantId: run.tenantId });
    await expect(store.save({ type: "TRACE", fileName: "trace.zip", body: Buffer.from("x"), contentType: "application/zip", sha256: "0".repeat(64), sensitivity: "STANDARD" })).rejects.toThrow(/SHA-256/);
    expect(deleted).toEqual([`tenants/${run.tenantId}/runs/${run.id}/traces/trace-0000000000000000.zip`]);
    expect(await new ArtifactRepository(h.tdb.db).listByRun(run.id)).toEqual([]);
  });
});

describe("runner output in the run log (admin run logs)", () => {
  it("logs the runner's stderr tail as runner lines", async () => {
    const lines: [Record<string, unknown>, string | undefined][] = [];
    const logger = { ...silentLogger, info: (obj: object, msg?: string) => void lines.push([obj as Record<string, unknown>, msg]) };
    const spawn = loggedSpawn(async () => ({ exitCode: 1, signal: null, stderrTail: "  1 failed\n\n[chromium] › cart.spec.ts:3 \n" }), logger);
    const result = await spawn({ runId: "run_1", cwd: "/w", cliPath: "cli.js", args: [], env: {}, tmpDir: "/w/tmp", signal: new AbortController().signal });
    expect(result).toMatchObject({ exitCode: 1 });
    expect(lines).toEqual([
      [{ runId: "run_1", source: "runner" }, "1 failed"],
      [{ runId: "run_1", source: "runner" }, "[chromium] › cart.spec.ts:3"],
    ]);
  });

  it("keeps the last 200 lines and logs nothing without a run id", async () => {
    const lines: string[] = [];
    const logger = { ...silentLogger, info: (_o: object, msg?: string) => void lines.push(msg ?? "") };
    const tail = Array.from({ length: 250 }, (_, i) => `line ${i}`).join("\n");
    await loggedSpawn(async () => ({ exitCode: 0, signal: null, stderrTail: tail }), logger)({ runId: "run_1", cwd: "/w", cliPath: "c", args: [], env: {}, tmpDir: "/t", signal: new AbortController().signal });
    expect(lines).toHaveLength(200);
    expect(lines[0]).toBe("line 50");
    lines.length = 0;
    await loggedSpawn(async () => ({ exitCode: 0, signal: null, stderrTail: tail }), logger)({ cwd: "/w", cliPath: "c", args: [], env: {}, tmpDir: "/t", signal: new AbortController().signal });
    expect(lines).toEqual([]);
  });
});
