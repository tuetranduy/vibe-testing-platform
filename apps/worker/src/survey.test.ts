import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ArtifactRepository } from "@platform/db";
import { createLocalStorage } from "@platform/storage";
import type { StageContext } from "@platform/testing-engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { silentLogger } from "./deps";
import { createSurveyDeps } from "./survey";
import { createHarness, seedRun, type WorkerHarness } from "./test-support";

let h: WorkerHarness;
let dir: string;
beforeAll(async () => {
  h = await createHarness();
  dir = mkdtempSync(path.join(os.tmpdir(), "worker-survey-store-"));
});
afterAll(async () => {
  await h?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date("2026-09-28T10:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

describe("createSurveyDeps", () => {
  it("stores survey screenshots as SCREENSHOT artifacts whose expiry follows their sensitivity", async () => {
    const run = await seedRun(h, { requirement: "" });
    const deps = createSurveyDeps({
      db: h.tdb.db,
      storage: createLocalStorage({ rootDir: dir }),
      logger: silentLogger,
      config: { privateAllowlist: [], artifactRetentionDays: 30, secretArtifactRetentionDays: 7 },
      now: () => NOW,
    });
    const store = deps.store({ runId: run.id, tenantId: run.tenantId } as StageContext);
    const standard = await store.saveScreenshot({ png: Buffer.from("png-1"), fileName: "survey-1.png", sensitivity: "STANDARD" });
    const secret = await store.saveScreenshot({ png: Buffer.from("png-2"), fileName: "survey-2.png", sensitivity: "SECRET_BEARING" });

    const rows = new Map((await new ArtifactRepository(h.tdb.db).listByRun(run.id)).map((r) => [r.id, r]));
    expect(rows.get(standard.artifactId)).toMatchObject({ type: "SCREENSHOT", contentType: "image/png", sensitivity: "STANDARD", expiresAt: new Date(NOW.getTime() + 30 * DAY) });
    expect(rows.get(secret.artifactId)).toMatchObject({ sensitivity: "SECRET_BEARING", expiresAt: new Date(NOW.getTime() + 7 * DAY) });
  });
});
