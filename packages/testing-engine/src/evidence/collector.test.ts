import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TestEventSchema } from "@platform/contracts";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EventDraft } from "../orchestrator/stages";
import { collectEvidence, type EvidenceStore, type EvidenceUpload, type LocalArtifact } from "./collector";

/**
 * Step 5 (Task 17): each rerun evidence file → scrub if trace → SHA-256 → store (object + Artifact
 * row, done by the worker's port) → `artifact.created`. A trace that cannot be scrubbed is dropped
 * with `artifact.omitted` (never uploaded unscrubbed).
 */

const SECRET = "Hunter2-Rerun-Secret";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "evidence-collector-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function file(name: string, body: Uint8Array | string): string {
  const p = path.join(dir, name);
  writeFileSync(p, body);
  return p;
}
const trace = (name = "trace.zip") =>
  file(name, zipSync({ "0-trace.trace": strToU8(JSON.stringify({ type: "before", method: "fill", params: { value: SECRET } })) }));
const artifact = (type: LocalArtifact["type"], p: string, contentType: string): LocalArtifact => ({ type, path: p, contentType, fileName: path.basename(p) });

function recorder() {
  const uploads: EvidenceUpload[] = [];
  const events: EventDraft[] = [];
  const store: EvidenceStore = {
    async save(upload) {
      uploads.push(upload);
      return { artifactId: `art_${uploads.length}` };
    },
  };
  const ctx = { publish: async (e: EventDraft) => void events.push(e) };
  return { uploads, events, store, ctx };
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

describe("collectEvidence", () => {
  it("uploads every file (trace scrubbed first) with its SHA-256, publishes artifact.created per upload, returns the ids", async () => {
    const { uploads, events, store, ctx } = recorder();
    const files = [
      artifact("TRACE", trace(), "application/zip"),
      artifact("SCREENSHOT", file("test-failed-1.png", "png-bytes"), "image/png"),
      artifact("VIDEO", file("video.webm", "webm-bytes"), "video/webm"),
    ];

    const ids = await collectEvidence(ctx, files, { store, secretValues: [SECRET] });

    expect(ids).toEqual(["art_1", "art_2", "art_3"]);
    expect(uploads.map((u) => [u.type, u.fileName, u.contentType, u.sensitivity])).toEqual([
      ["TRACE", "trace.zip", "application/zip", "SECRET_BEARING"],
      ["SCREENSHOT", "test-failed-1.png", "image/png", "SECRET_BEARING"],
      ["VIDEO", "video.webm", "video/webm", "SECRET_BEARING"],
    ]);
    for (const u of uploads) expect(u.sha256).toBe(sha256(u.body));
    const uploadedTrace = unzipSync(uploads[0]!.body);
    expect(strFromU8(uploadedTrace["0-trace.trace"]!)).toContain("[REDACTED]");
    expect(Buffer.from(uploads[0]!.body).includes(Buffer.from(SECRET))).toBe(false);
    expect(Buffer.from(uploads[1]!.body).toString()).toBe("png-bytes");

    expect(events).toEqual([
      { type: "artifact.created", message: "Rerun trace stored", payload: { artifactId: "art_1", type: "TRACE", sensitivity: "SECRET_BEARING" } },
      { type: "artifact.created", message: "Rerun screenshot stored", payload: { artifactId: "art_2", type: "SCREENSHOT", sensitivity: "SECRET_BEARING" } },
      { type: "artifact.created", message: "Rerun video stored", payload: { artifactId: "art_3", type: "VIDEO", sensitivity: "SECRET_BEARING" } },
    ]);
    for (const e of events) TestEventSchema.parse({ ...e, id: "e", runId: "run_1", sequence: 1, stage: "RUNNING_PLAYWRIGHT", timestamp: "2026-09-26T10:00:00.000Z" });
  });

  it("a run without secrets → STANDARD sensitivity", async () => {
    const { uploads, events, store, ctx } = recorder();
    await collectEvidence(ctx, [artifact("TRACE", trace(), "application/zip")], { store, secretValues: [] });
    expect(uploads.map((u) => u.sensitivity)).toEqual(["STANDARD"]);
    expect(events[0]).toMatchObject({ type: "artifact.created", payload: { sensitivity: "STANDARD" } });
  });

  it("an unparseable trace is dropped (never uploaded) and artifact.omitted is published; the other files still upload", async () => {
    const { uploads, events, store, ctx } = recorder();
    const files = [
      artifact("TRACE", file("trace.zip", `not a zip ${SECRET}`), "application/zip"),
      artifact("SCREENSHOT", file("test-failed-1.png", "png-bytes"), "image/png"),
    ];

    const ids = await collectEvidence(ctx, files, { store, secretValues: [SECRET] });

    expect(ids).toEqual(["art_1"]);
    expect(uploads.map((u) => u.type)).toEqual(["SCREENSHOT"]);
    expect(events[0]).toEqual({
      type: "artifact.omitted",
      message: "Rerun trace omitted",
      payload: { type: "TRACE", reason: "The trace could not be read to remove secrets, so it was not stored" },
    });
    expect(events[1]).toMatchObject({ type: "artifact.created", payload: { type: "SCREENSHOT" } });
  });

  it("a listed file that is missing → artifact.omitted, nothing uploaded for it", async () => {
    const { uploads, events, store, ctx } = recorder();
    await collectEvidence(ctx, [artifact("VIDEO", path.join(dir, "gone.webm"), "video/webm")], { store, secretValues: [] });
    expect(uploads).toEqual([]);
    expect(events).toEqual([
      { type: "artifact.omitted", message: "Rerun video omitted", payload: { type: "VIDEO", reason: "The rerun did not leave this file behind" } },
    ]);
  });

  it("a storage failure propagates (infrastructure error, like exploration screenshots)", async () => {
    const ctx = { publish: async () => {} };
    const store: EvidenceStore = { save: async () => Promise.reject(Object.assign(new Error("S3 down"), { name: "StorageError" })) };
    await expect(collectEvidence(ctx, [artifact("SCREENSHOT", file("a.png", "x"), "image/png")], { store, secretValues: [] })).rejects.toThrow("S3 down");
  });

  it("stops at the run signal: no upload and no event after an abort (cancel / deadline mid-collection)", async () => {
    const uploads: EvidenceUpload[] = [];
    const events: EventDraft[] = [];
    const controller = new AbortController();
    const store: EvidenceStore = {
      async save(upload) {
        uploads.push(upload);
        controller.abort(new Error("run cancelled")); // the run is cancelled while the first file uploads
        return { artifactId: `art_${uploads.length}` };
      },
    };
    const ctx = { publish: async (e: EventDraft) => void events.push(e), signal: controller.signal };
    const files = [
      artifact("SCREENSHOT", file("test-failed-1.png", "png-bytes"), "image/png"),
      artifact("VIDEO", file("video.webm", "webm-bytes"), "video/webm"),
      artifact("TRACE", trace(), "application/zip"),
    ];
    await collectEvidence(ctx, files, { store, secretValues: [SECRET] });
    expect(uploads.map((u) => u.type)).toEqual(["SCREENSHOT"]);
    expect(events).toEqual([]);

    // Already aborted: nothing at all.
    const none = recorder();
    expect(await collectEvidence({ ...none.ctx, signal: controller.signal }, files, { store: none.store, secretValues: [] })).toEqual([]);
    expect(none.uploads).toEqual([]);
    expect(none.events).toEqual([]);
  });
});
