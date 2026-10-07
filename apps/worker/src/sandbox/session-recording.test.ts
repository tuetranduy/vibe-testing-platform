import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { unzipSync } from "fflate";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findFreePort, launchSandboxedBrowser } from "./browser-launcher";
import { MAX_STILL_SECONDS, ScreenFrames, ffmpegArgs, framesFor, isPageCaptureFrame, resolveFfmpegPath, startSessionRecording } from "./session-recording";

describe("framesFor", () => {
  it("repeats a frame for as long as it was shown, at 25 fps: at least once, idle pauses shortened", () => {
    expect(framesFor(0)).toBe(1);
    expect(framesFor(0.2)).toBe(5);
    expect(framesFor(1)).toBe(25);
    expect(framesFor(60)).toBe(25 * MAX_STILL_SECONDS);
    expect(framesFor(-3)).toBe(1);
    expect(framesFor(Number.NaN)).toBe(1);
  });

  it("ffmpeg reads MJPEG on stdin and writes a fixed-size VP8 WebM, frames scaled to fit and letterboxed in black", () => {
    const args = ffmpegArgs("/tmp/x.webm", { width: 1280, height: 720 });
    expect(args.slice(args.indexOf("-i"), args.indexOf("-i") + 2)).toEqual(["-i", "pipe:0"]);
    expect(args).toContain("vp8");
    expect(args).toContain("scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:0:0:black");
    expect(args.at(-1)).toBe("/tmp/x.webm");
  });

  it("a frame of a full-page screenshot (the whole page, much taller than the screen) is not a frame of the video", () => {
    const size = { width: 1920, height: 1080 };
    expect(isPageCaptureFrame({ deviceWidth: 1905, deviceHeight: 6000 }, size)).toBe(true);
    expect(isPageCaptureFrame({ deviceWidth: 1920, deviceHeight: 1080 }, size)).toBe(false);
    expect(isPageCaptureFrame({ deviceWidth: 1920, deviceHeight: 941 }, size)).toBe(false);
    expect(isPageCaptureFrame({ deviceWidth: 1920, deviceHeight: 1200 }, size)).toBe(false);
    expect(isPageCaptureFrame({ deviceWidth: 800, deviceHeight: 600 }, size)).toBe(false);
    expect(isPageCaptureFrame({}, size)).toBe(false);
  });

  it("after a full-page capture, the screen before it stays on until the page is back at its size (at most 1 s)", () => {
    const screen = new ScreenFrames({ width: 1920, height: 1080 });
    const hd = { deviceWidth: 1920, deviceHeight: 1080 };
    const window = { deviceWidth: 1920, deviceHeight: 888 };
    const capture = { deviceWidth: 1905, deviceHeight: 6000 };
    expect(screen.keep(hd, 10)).toBe(true);
    expect(screen.keep(capture, 11)).toBe(false);
    expect(screen.keep(window, 11.1)).toBe(false); // between the capture and the viewport set back
    expect(screen.keep(hd, 11.2)).toBe(true);
    expect(screen.keep(capture, 12)).toBe(false);
    expect(screen.keep(window, 12.5)).toBe(false);
    expect(screen.keep(window, 13.1)).toBe(true); // never back to its size: shown after 1 s
    expect(screen.keep(window, 14)).toBe(true);
    expect(screen.keep(capture, 15)).toBe(false);
    expect(screen.keep(hd, 15.1)).toBe(true); // larger than the screen before: the page got its full size back
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

/**
 * The exploration's own browser (the sandbox launcher: new headless, full HD) with full-page screenshots taken while
 * recording, as every checkpoint does. The video is played in Chromium the way the report plays it: every moment after
 * the page appears must show the page, never the gray of a full-page capture strip or of a viewport that shrank
 * (2026-10-07: "the video shows a gray screen").
 */
describe("exploration video with full-page screenshots (sandbox browser)", () => {
  it("shows the page throughout, and the page stays full HD", async () => {
    const sandbox = await launchSandboxedBrowser({ proxyUrl: "http://127.0.0.1:9", runId: `video-${process.pid}-${Date.now()}` });
    const cleanups: (() => Promise<void> | void)[] = [];
    let player: Browser | undefined;
    try {
      const page = sandbox.page;
      await sandbox.restoreViewport(); // as the exploration does before recording
      const recording = await startSessionRecording({ runId: "run_vid", addCleanup: (fn) => void cleanups.push(fn) }, page, { video: true, trace: false });
      await page.setContent(
        "<body style='margin:0;height:6000px;background:#c00'><h1 id=t style='color:#fff'>0</h1><script>let n=0;setInterval(()=>{document.getElementById('t').textContent=String(++n)},50)</script></body>",
      );
      await page.waitForTimeout(500);
      // As the explorer's screenshot does: a full-page capture, then the viewport set back.
      for (let i = 0; i < 2; i++) {
        await page.screenshot({ type: "png", fullPage: true });
        await sandbox.restoreViewport();
        await page.waitForTimeout(400);
      }
      expect(await page.evaluate(() => [innerWidth, innerHeight])).toEqual([1920, 1080]);
      const files = await recording!.stop();
      const video = await readFile(files.find((f) => f.type === "VIDEO")!.path);

      player = await chromium.launch();
      const view = await player.newPage();
      await view.setContent("<video id=v muted></video>");
      // The bottom-right corner of each sampled moment: red is the page, anything else is padding or a capture strip.
      const corners = await view.evaluate(async (src) => {
        const v = document.getElementById("v") as HTMLVideoElement;
        v.src = src;
        await new Promise((resolve, reject) => {
          v.onloadeddata = resolve;
          v.onerror = () => reject(new Error(`video error ${v.error?.code}`));
        });
        const canvas = document.createElement("canvas");
        canvas.width = 32;
        canvas.height = 18;
        const g = canvas.getContext("2d")!;
        const out: number[][] = [];
        for (let t = 0.05; t < v.duration - 0.05; t += 0.1) {
          v.currentTime = t;
          await new Promise((resolve) => (v.onseeked = resolve));
          g.drawImage(v, 0, 0, 32, 18);
          out.push(Array.from(g.getImageData(30, 16, 1, 1).data.slice(0, 3)));
        }
        return out;
      }, `data:video/webm;base64,${video.toString("base64")}`);
      const isRed = ([r, g, b]: number[]) => r! > 150 && g! < 80 && b! < 80;
      const first = corners.findIndex(isRed);
      expect(first).toBeGreaterThanOrEqual(0);
      expect(corners.slice(first).filter((c) => !isRed(c))).toEqual([]);
      await recording!.discard();
    } finally {
      for (const fn of cleanups) await fn();
      await player?.close().catch(() => {});
      await sandbox.close();
    }
  }, 90_000);
});
