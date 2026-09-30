import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CancelledError, type NormalizedRequirement, type TestPlan } from "@platform/contracts";
import { FakeTransport, LlmClient } from "@platform/llm";
import type { ExplorerSession } from "@platform/stagehand-adapter/browser-explorer";
import { strFromU8, unzipSync, zipSync } from "fflate";
import type { Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { EvidenceUpload } from "../evidence/collector";
import type { EventDraft, StageContext } from "../orchestrator/stages";
import type { SurveySandbox } from "../survey/site-reader";
import { createCaptureEvidenceStage } from "./evidence-snapshot";
import { createExploreStage, type ExplorationSandbox, type SessionRecording } from "./explore-stage";

const SECRET = "pw-Recorded-4242";
const plan = {
  runId: "run_rec",
  requirementRevision: 1,
  scenarios: [{ id: "SC-1", title: "t", criterionIds: ["AC-1"], steps: [{ id: "PS-1", kind: "navigate", description: "Open the shop", criterionIds: [], destructive: false }] }],
  blockedCriteria: [],
  stopConditions: [],
} as TestPlan;
const requirement = { facts: [], criteria: [] } as unknown as NormalizedRequirement;

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "rec-test-"));
});
afterAll(async () => rm(dir, { recursive: true, force: true }));

function context(secrets: Record<string, string> = {}, signal = new AbortController().signal) {
  const events: EventDraft[] = [];
  const ctx = {
    runId: "run_rec",
    tenantId: "t_1",
    request: { targetUrl: "https://shop.test/", environment: "staging", testData: {}, secretNames: Object.keys(secrets), options: { maxExplorationSteps: 10, allowDestructiveActions: false } },
    signal,
    deadlineAt: null,
    budgets: { explorationMs: 1000, rerunMs: 1000 },
    secrets: { names: Object.keys(secrets), get: (n: string) => secrets[n] },
    redact: (v: unknown) => v,
    publish: async (e: EventDraft) => void events.push(e),
    addCleanup: () => {},
    boundary: async () => {},
    budgetSignal: () => new AbortController().signal,
    now: () => new Date(),
    llm: new LlmClient({ transport: new FakeTransport(), model: "claude-sonnet-5", logger: { warn() {} } }),
  } as unknown as StageContext;
  return { ctx, events };
}

function exploreStage(recording: () => Promise<SessionRecording | null>) {
  const log: string[] = [];
  const uploads: EvidenceUpload[] = [];
  const sandbox = { cdpUrl: "http://127.0.0.1:1", extensionIds: ["x"], page: {} as Page, close: async () => void log.push("sandbox.close") } as ExplorationSandbox;
  const session = {
    page: { url: () => "https://shop.test/", isClosed: () => false, waitForLoadState: async () => {} } as unknown as Page,
    navigate: async (url: string) => ({ url }),
    close: async () => void log.push("session.close"),
  } as unknown as ExplorerSession;
  const stage = createExploreStage({
    openSandbox: async () => sandbox,
    explorer: { start: async () => session },
    store: () => ({ saveStep: async () => {}, saveFact: async () => {}, saveScreenshot: async () => ({ artifactId: "a" }) }),
    startRecording: async () => {
      log.push("recording.start");
      return recording();
    },
    recordingStore: () => ({
      save: async (u) => {
        uploads.push(u);
        return { artifactId: `art_${u.type.toLowerCase()}` };
      },
    }),
    logger: { error() {}, warn() {} },
  });
  return { stage, log, uploads };
}

async function files(): Promise<{ trace: string; video: string }> {
  const trace = path.join(dir, `trace-${Math.random()}.zip`);
  await writeFile(trace, zipSync({ "trace.trace": new TextEncoder().encode(`{"type":"action","params":{"value":"${SECRET}"}}`) }));
  const video = path.join(dir, `video-${Math.random()}.webm`);
  await writeFile(video, Buffer.from("webm"));
  return { trace, video };
}

describe("exploration recordings (V1.3)", () => {
  it("are stopped before the sandbox closes, stored (the trace scrubbed of secrets) and returned as run-wide evidence", async () => {
    const f = await files();
    const discard = vi.fn(async () => {});
    const h = exploreStage(async () => ({
      stop: async () => {
        h.log.push("recording.stop");
        return [
          { type: "VIDEO", path: f.video, contentType: "video/webm", fileName: "exploration.webm" },
          { type: "TRACE", path: f.trace, contentType: "application/zip", fileName: "exploration-trace.zip" },
        ];
      },
      discard,
    }));
    const { ctx, events } = context({ password: SECRET });
    const outcome = await h.stage(ctx, plan, requirement);

    expect(outcome.artifactIds).toEqual(["art_video", "art_trace"]);
    expect(h.log.indexOf("recording.stop")).toBeLessThan(h.log.indexOf("sandbox.close"));
    expect(discard).toHaveBeenCalled();
    expect(h.uploads.map((u) => [u.type, u.sensitivity])).toEqual([
      ["VIDEO", "SECRET_BEARING"],
      ["TRACE", "SECRET_BEARING"],
    ]);
    const trace = strFromU8(unzipSync(h.uploads[1]!.body)["trace.trace"]!);
    expect(trace).not.toContain(SECRET);
    expect(trace).toContain("[REDACTED]");
    expect(events.filter((e) => e.type === "artifact.created").map((e) => e.message)).toEqual(["Exploration video stored", "Exploration trace stored"]);
  });

  it("a storage failure while keeping the recordings is an infrastructure error, even after the budget ran out", async () => {
    const f = await files();
    const { ctx } = context();
    const spent = new AbortController();
    spent.abort(new DOMException("timed out", "TimeoutError"));
    ctx.budgetSignal = () => spent.signal; // the budget ran out: exploration returns at once
    const stage = createExploreStage({
      openSandbox: async () => ({ cdpUrl: "http://127.0.0.1:1", extensionIds: ["x"], page: {} as Page, close: async () => {} }),
      explorer: { start: async () => ({ page: {} as Page, close: async () => {} }) as unknown as ExplorerSession },
      store: () => ({ saveStep: async () => {}, saveFact: async () => {}, saveScreenshot: async () => ({ artifactId: "a" }) }),
      startRecording: async () => ({ stop: async () => [{ type: "VIDEO", path: f.video, contentType: "video/webm", fileName: "x.webm" }], discard: async () => {} }),
      recordingStore: () => ({
        save: async () => {
          throw Object.assign(new Error("S3 unavailable"), { name: "StorageError" });
        },
      }),
    });
    await expect(stage(ctx, plan, requirement)).rejects.toThrow("S3 unavailable");
  });

  it("a recorder that fails to start never stops the exploration", async () => {
    const h = exploreStage(async () => {
      throw new Error("ffmpeg not found");
    });
    const { ctx, events } = context();
    const outcome = await h.stage(ctx, plan, requirement);
    expect(outcome.stopReason).toBe("COMPLETED");
    expect(outcome.artifactIds).toBeUndefined();
    expect(events.find((e) => e.type === "artifact.omitted")?.message).toBe("Exploration recording omitted");
  });

  it("a recording that cannot be finished is omitted; the outcome stands", async () => {
    const h = exploreStage(async () => ({
      stop: async () => {
        throw new Error("tracing.stop: browser closed");
      },
      discard: async () => {},
    }));
    const { ctx, events } = context();
    const outcome = await h.stage(ctx, plan, requirement);
    expect(outcome.stopReason).toBe("COMPLETED");
    expect(outcome.artifactIds).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: "artifact.omitted", payload: { reason: "The recording could not be finished" } });
  });
});

function snapshotSandbox(opts: { fail?: boolean } = {}) {
  let current = "about:blank";
  const shots: { fullPage?: boolean }[] = [];
  const close = vi.fn(async () => {});
  const sandbox: SurveySandbox = {
    page: {
      url: () => current,
      goto: async (url: string) => {
        if (opts.fail) throw new Error("net::ERR_CONNECTION_REFUSED");
        current = url;
        return null;
      },
      screenshot: async (o: { fullPage?: boolean }) => (shots.push(o), Buffer.from("PNG")),
    } as unknown as Page,
    close,
  };
  return { sandbox, close, shots };
}

describe("captureEvidence: the start page of a run whose every criterion is blocked (V1.3)", () => {
  const store = () => {
    const steps: unknown[] = [];
    const shots: string[] = [];
    return {
      steps,
      shots,
      port: () => ({
        saveStep: async (s: unknown) => void steps.push(s),
        saveScreenshot: async (i: { fileName: string }) => (shots.push(i.fileName), { artifactId: "art_start" }),
      }),
    };
  };

  it("loads the target URL, stores a full-page screenshot and records it as one screenshot step off the golden path", async () => {
    const sb = snapshotSandbox();
    const st = store();
    const { ctx, events } = context();
    const steps = await createCaptureEvidenceStage({ openSandbox: async () => sb.sandbox, store: st.port })(ctx);

    expect(sb.shots).toEqual([{ type: "png", fullPage: true }]);
    expect(st.shots).toEqual(["blocked-start-page.png"]);
    expect(steps).toMatchObject([
      { kind: "screenshot", plannedStepId: null, onGoldenPath: false, outcome: "SUCCESS", artifactIds: ["art_start"], urlAfter: "https://shop.test/" },
    ]);
    expect(st.steps).toEqual(steps);
    expect(events.map((e) => e.type)).toEqual(["artifact.created", "step.recorded"]);
    expect(sb.close).toHaveBeenCalled();
  });

  it("is best effort: a page that does not load, or a browser that does not start → [] with artifact.omitted", async () => {
    const sb = snapshotSandbox({ fail: true });
    const { ctx, events } = context();
    expect(await createCaptureEvidenceStage({ openSandbox: async () => sb.sandbox, store: store().port })(ctx)).toEqual([]);
    expect(sb.close).toHaveBeenCalled();
    const noBrowser = createCaptureEvidenceStage({
      openSandbox: async () => {
        throw new Error("No usable sandbox!");
      },
      store: store().port,
    });
    expect(await noBrowser(ctx)).toEqual([]);
    expect(events.filter((e) => e.type === "artifact.omitted").map((e) => (e.payload as { reason: string }).reason)).toEqual([
      "The start page could not be loaded",
      "The browser could not be started",
    ]);
  });

  it("a cancel still ends the run", async () => {
    const ac = new AbortController();
    ac.abort(new CancelledError());
    const { ctx } = context({}, ac.signal);
    const stage = createCaptureEvidenceStage({
      openSandbox: async () => {
        throw new Error("aborted");
      },
      store: store().port,
    });
    await expect(stage(ctx)).rejects.toBeInstanceOf(CancelledError);
  });
});
