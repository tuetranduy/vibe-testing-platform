import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ArtifactRepository } from "@platform/db";
import { TEST_TENANT_ID } from "@platform/db/testing";
import { createLocalStorage, resolveLocalObjectPath, type ArtifactStorage } from "@platform/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { storeArtifact } from "../artifacts";
import { silentLogger } from "../deps";
import { createHarness, seedRun, type WorkerHarness } from "../test-support";
import { retentionJob } from "./retention";

let h: WorkerHarness;
let root: string;
beforeAll(async () => {
  h = await createHarness();
  root = mkdtempSync(path.join(os.tmpdir(), "retention-"));
});
afterAll(async () => {
  await h?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

const DAY = 24 * 3_600_000;
const T0 = new Date("2026-09-01T00:00:00.000Z");
const at = (days: number) => new Date(T0.getTime() + days * DAY);

async function seedArtifacts(storage: ArtifactStorage) {
  const run = await seedRun(h);
  const deps = { db: h.tdb.db, storage, config: { artifactRetentionDays: 30, secretArtifactRetentionDays: 7 }, now: () => T0 };
  const base = { tenantId: TEST_TENANT_ID, runId: run.id, type: "SCREENSHOT", contentType: "image/png", body: Buffer.from("png") } as const;
  const secret = await storeArtifact(deps, { ...base, fileName: "secret.png", sensitivity: "SECRET_BEARING" });
  const standard = await storeArtifact(deps, { ...base, fileName: "standard.png", sensitivity: "STANDARD" });
  const rows = await new ArtifactRepository(h.tdb.db).listByRun(run.id);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  return { run, secret: byId[secret.artifactId]!, standard: byId[standard.artifactId]! };
}

describe("retentionJob (fake clock)", () => {
  it("day 8 deletes SECRET_BEARING (7 days) from storage and DB; STANDARD (30 days) stays until day 31", async () => {
    const storage = createLocalStorage({ rootDir: root });
    const { run, secret, standard } = await seedArtifacts(storage);
    const repo = new ArtifactRepository(h.tdb.db);

    expect(await retentionJob({ db: h.tdb.db, storage, logger: silentLogger, now: () => at(6) })).toEqual({ deleted: 0, failed: 0, stoppedEarly: false });

    expect(await retentionJob({ db: h.tdb.db, storage, logger: silentLogger, now: () => at(8) })).toEqual({ deleted: 1, failed: 0, stoppedEarly: false });
    expect((await repo.listByRun(run.id)).map((a) => a.id)).toEqual([standard.id]);
    expect(existsSync(resolveLocalObjectPath(root, secret.objectKey))).toBe(false);
    expect(existsSync(resolveLocalObjectPath(root, standard.objectKey))).toBe(true);

    expect(await retentionJob({ db: h.tdb.db, storage, logger: silentLogger, now: () => at(31) })).toEqual({ deleted: 1, failed: 0, stoppedEarly: false });
    expect(await repo.listByRun(run.id)).toEqual([]);
    expect(existsSync(resolveLocalObjectPath(root, standard.objectKey))).toBe(false);
  });

  it("walks past a full batch of expired rows", async () => {
    const storage = createLocalStorage({ rootDir: root });
    const seeded = [await seedArtifacts(storage), await seedArtifacts(storage)];
    const result = await retentionJob({ db: h.tdb.db, storage, logger: silentLogger, now: () => at(40), batchSize: 1 });
    expect(result.deleted).toBeGreaterThanOrEqual(4);
    for (const s of seeded) expect(await new ArtifactRepository(h.tdb.db).listByRun(s.run.id)).toEqual([]);
  });

  it("a storage outage keeps the rows for the next pass, is logged, and never throws; other artifacts are still deleted", async () => {
    const good = createLocalStorage({ rootDir: root });
    const { run, secret, standard } = await seedArtifacts(good);
    const warnings: object[] = [];
    const flaky: ArtifactStorage = {
      ...good,
      put: good.put.bind(good),
      getSignedReadUrl: good.getSignedReadUrl.bind(good),
      ensureReady: good.ensureReady.bind(good),
      delete: async (key) => (key === secret.objectKey ? Promise.reject(new Error("s3 down")) : good.delete(key)),
    };
    const result = await retentionJob({
      db: h.tdb.db,
      storage: flaky,
      logger: { ...silentLogger, warn: (o) => void warnings.push(o) },
      now: () => at(31),
    });
    expect(result.failed).toBe(1);
    expect((await new ArtifactRepository(h.tdb.db).listByRun(run.id)).map((a) => a.id)).toEqual([secret.id]);
    expect(existsSync(resolveLocalObjectPath(root, standard.objectKey))).toBe(false);
    expect(warnings).toContainEqual(expect.objectContaining({ runId: run.id, artifactId: secret.id }));

    // The next pass, with storage back, finishes the job.
    expect((await retentionJob({ db: h.tdb.db, storage: good, logger: silentLogger, now: () => at(31) })).failed).toBe(0);
    expect(await new ArtifactRepository(h.tdb.db).listByRun(run.id)).toEqual([]);
  });

  it("a delete that never returns ends the pass at its time limit; nothing else is started and the rows stay for the next pass", async () => {
    const good = createLocalStorage({ rootDir: root });
    const { run } = await seedArtifacts(good);
    const warnings: { obj: object; msg?: string }[] = [];
    let deletes = 0;
    const hung: ArtifactStorage = {
      ...good,
      put: good.put.bind(good),
      getSignedReadUrl: good.getSignedReadUrl.bind(good),
      ensureReady: good.ensureReady.bind(good),
      delete: () => {
        deletes += 1;
        return new Promise<void>(() => {});
      },
    };
    const pass = (day: number) =>
      retentionJob({
        db: h.tdb.db,
        storage: hung,
        logger: { ...silentLogger, warn: (obj, msg) => void warnings.push({ obj, msg }) },
        now: () => at(day),
        passTimeoutMs: 300,
      });

    // Day 8: only the SECRET_BEARING artifact is expired, and its delete hangs.
    let started = Date.now();
    expect(await pass(8)).toEqual({ deleted: 0, failed: 1, stoppedEarly: true });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(deletes).toBe(1);
    // Day 31: both are expired; the first delete hangs, the second is never started.
    started = Date.now();
    expect(await pass(31)).toEqual({ deleted: 0, failed: 1, stoppedEarly: true });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(deletes).toBe(2);
    expect(await new ArtifactRepository(h.tdb.db).listByRun(run.id)).toHaveLength(2);
    expect(warnings.map((w) => w.msg)).toContainEqual(expect.stringMatching(/time limit/));

    // The next pass, with a store that answers, deletes them.
    expect(await retentionJob({ db: h.tdb.db, storage: good, logger: silentLogger, now: () => at(31) })).toMatchObject({ failed: 0, stoppedEarly: false });
    expect(await new ArtifactRepository(h.tdb.db).listByRun(run.id)).toEqual([]);
  });
});
