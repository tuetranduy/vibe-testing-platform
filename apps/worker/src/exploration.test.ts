import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ArtifactRepository, ExplorationStepRepository, ObservedFactRepository } from "@platform/db";
import { createLocalStorage, resolveLocalObjectPath, type ArtifactStorage } from "@platform/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createExplorationStore } from "./exploration";
import { createHarness, seedRun, type WorkerHarness } from "./test-support";

let h: WorkerHarness;
let dir: string;
beforeAll(async () => {
  h = await createHarness();
  dir = mkdtempSync(path.join(os.tmpdir(), "worker-exploration-store-"));
});
afterAll(async () => {
  await h?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date("2026-09-26T10:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const config = { artifactRetentionDays: 30, secretArtifactRetentionDays: 7 };

describe("createExplorationStore", () => {
  it("persists steps and facts (validated) and screenshots with an artifacts row whose expiry follows sensitivity", async () => {
    const run = await seedRun(h);
    const storage = createLocalStorage({ rootDir: dir });
    const store = createExplorationStore({ db: h.tdb.db, storage, config, now: () => NOW }, { runId: run.id, tenantId: run.tenantId });

    await store.saveStep({
      id: "step_a",
      runId: run.id,
      index: 0,
      plannedStepId: "PS-1",
      kind: "navigate",
      instruction: "Navigate to https://shop.example.com/",
      element: null,
      inputRef: null,
      onGoldenPath: true,
      urlBefore: "about:blank",
      urlAfter: "https://shop.example.com/",
      outcome: "SUCCESS",
      blockReason: null,
      error: null,
      startedAt: NOW.toISOString(),
      durationMs: 5,
      artifactIds: [],
      llm: null,
    });
    await store.saveFact({ key: "url", checkpoint: "before_add", value: "https://shop.example.com/", provenance: "DOM_VERIFIED", read: null, stepId: "step_a" });
    const standard = await store.saveScreenshot({ png: Buffer.from("png-1"), fileName: "before_add.png", sensitivity: "STANDARD" });
    const secret = await store.saveScreenshot({ png: Buffer.from("png-2"), fileName: "after_login.png", sensitivity: "SECRET_BEARING" });

    expect((await new ExplorationStepRepository(h.tdb.db).listByRun(run.id)).map((s) => s.id)).toEqual(["step_a"]);
    expect((await new ObservedFactRepository(h.tdb.db).listByRun(run.id)).map((f) => f.key)).toEqual(["url"]);
    const rows = await new ArtifactRepository(h.tdb.db).listByRun(run.id);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(standard.artifactId)).toMatchObject({ type: "SCREENSHOT", contentType: "image/png", sensitivity: "STANDARD", bytes: 5, expiresAt: new Date(NOW.getTime() + 30 * DAY) });
    expect(byId.get(secret.artifactId)).toMatchObject({ sensitivity: "SECRET_BEARING", expiresAt: new Date(NOW.getTime() + 7 * DAY) });
    const key = byId.get(standard.artifactId)!.objectKey;
    expect(key).toMatch(new RegExp(`^tenants/${run.tenantId}/runs/${run.id}/screenshots/before_add-[0-9a-f]{16}\\.png$`));
    expect(existsSync(resolveLocalObjectPath(dir, key))).toBe(true);
  });

  it("removes the stored object when its artifacts row cannot be written", async () => {
    const deleted: string[] = [];
    const storage: ArtifactStorage = {
      put: async () => ({ objectKey: "tenants/t/runs/r/screenshots/x-0000000000000000.png", sha256: "0".repeat(64), bytes: 1 }),
      delete: async (k) => void deleted.push(k),
      getSignedReadUrl: async () => "",
      ensureReady: async () => {},
    };
    // A run id with no test_runs row → the FK rejects the insert.
    const store = createExplorationStore({ db: h.tdb.db, storage, config }, { runId: "run_missing", tenantId: "t_default" });
    await expect(store.saveScreenshot({ png: Buffer.from("x"), fileName: "cp.png", sensitivity: "STANDARD" })).rejects.toThrow();
    expect(deleted).toEqual(["tenants/t/runs/r/screenshots/x-0000000000000000.png"]);
  });
});
