import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { unzipSync } from "fflate";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findFreePort } from "./browser-launcher";
import { MAX_STILL_SECONDS, ffmpegArgs, framesFor, resolveFfmpegPath, startSessionRecording } from "./session-recording";

describe("framesFor", () => {
  it("repeats a frame for as long as it was shown, at 25 fps: at least once, idle pauses shortened", () => {
    expect(framesFor(0)).toBe(1);
    expect(framesFor(0.2)).toBe(5);
    expect(framesFor(1)).toBe(25);
    expect(framesFor(60)).toBe(25 * MAX_STILL_SECONDS);
    expect(framesFor(-3)).toBe(1);
    expect(framesFor(Number.NaN)).toBe(1);
  });

  it("ffmpeg reads MJPEG on stdin and writes a fixed-size VP8 WebM", () => {
    const args = ffmpegArgs("/tmp/x.webm", { width: 1280, height: 720 });
    expect(args.slice(args.indexOf("-i"), args.indexOf("-i") + 2)).toEqual(["-i", "pipe:0"]);
    expect(args).toContain("vp8");
    expect(args).toContain("pad=1280:720:0:0:gray,crop=1280:720:0:0");
    expect(args.at(-1)).toBe("/tmp/x.webm");
  });
});

/**
 * Against a real Chromium, reached over CDP like the exploration sandbox's (connectOverCDP: its existing
 * page, not a context Playwright created — the reason the video comes from the screencast).
 */
describe("startSessionRecording (real Chromium over CDP)", () => {
  let launched: Browser;
  let browser: Browser;
  let page: Page;
  let ffmpeg: string | null;
  const cleanups: (() => Promise<void> | void)[] = [];
  const ctx = { runId: "run_rec", addCleanup: (fn: () => Promise<void> | void) => void cleanups.push(fn) };

  beforeAll(async () => {
    ffmpeg = await resolveFfmpegPath();
    const port = await findFreePort();
    launched = await chromium.launch({ args: [`--remote-debugging-port=${port}`] });
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    page = context.pages()[0] ?? (await context.newPage());
  }, 60_000);

  afterAll(async () => {
    for (const fn of cleanups) await fn();
    await browser?.close().catch(() => {});
    await launched?.close().catch(() => {});
  });

  it("records a WebM video and a Playwright trace of what the page did", async () => {
    expect(ffmpeg).not.toBeNull(); // installed with Playwright's Chromium
    const recording = await startSessionRecording(ctx, page, { video: true, trace: true });
    expect(recording).not.toBeNull();
    await page.setContent("<h1 id=t>0</h1><script>let n=0;setInterval(()=>{document.getElementById('t').textContent=String(++n)},50)</script>");
    await page.click("h1");
    await page.waitForTimeout(800);
    const files = await recording!.stop();

    expect(files.map((f) => f.type).sort()).toEqual(["TRACE", "VIDEO"]);
    const video = await readFile(files.find((f) => f.type === "VIDEO")!.path);
    expect(video.subarray(0, 4)).toEqual(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])); // EBML (WebM) header
    const trace = unzipSync(new Uint8Array(await readFile(files.find((f) => f.type === "TRACE")!.path)));
    expect(Object.keys(trace)).toContain("trace.trace");
    expect(new TextDecoder().decode(trace["trace.trace"])).toContain("click");

    const dir = files[0]!.path.replace(/\/[^/]+$/, "");
    await recording!.discard();
    expect(existsSync(dir)).toBe(false);
  }, 60_000);

  it("records nothing when the run turns both off; without ffmpeg, the trace alone", async () => {
    expect(await startSessionRecording(ctx, page, { video: false, trace: false })).toBeNull();
    const traceOnly = await startSessionRecording(ctx, page, { video: true, trace: true, ffmpegPath: null });
    const files = await traceOnly!.stop();
    expect(files.map((f) => f.type)).toEqual(["TRACE"]);
    await traceOnly!.discard();
    expect(await startSessionRecording(ctx, page, { video: true, trace: false, ffmpegPath: null })).toBeNull();
  }, 60_000);

  it("discard before stop stops everything and keeps nothing", async () => {
    const recording = await startSessionRecording(ctx, page, { video: true, trace: true });
    await page.setContent("<p>discarded</p>");
    await recording!.discard();
    // Tracing is free again: a new recording can start on the same context.
    const again = await startSessionRecording(ctx, page, { video: false, trace: true });
    await again!.discard();
  }, 60_000);
});
