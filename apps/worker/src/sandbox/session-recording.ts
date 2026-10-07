import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { access, constants, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BROWSER_VIEWPORT, type SessionRecording, type StageContext } from "@platform/testing-engine";
import type { CDPSession, Page } from "playwright-core";

/**
 * The exploration's recordings (V1.3), on the sandbox's own page:
 *
 * - trace: Playwright tracing on the page's context (screenshots + DOM snapshots), written as a zip; the
 *   stage scrubs every secret value from it before upload (evidence/collector.ts).
 * - video: the page's CDP screencast (JPEG frames) piped into ffmpeg → VP8 WebM, the way Playwright's own
 *   `recordVideo` works (idle pauses are shortened, see framesFor). Playwright can only record a context it creates, and the explorer drives the
 *   sandbox browser's existing page over CDP, so the screencast is read directly. ffmpeg is Playwright's
 *   (`playwright-core install chromium` installs it next to Chromium), or FFMPEG_PATH.
 *
 * Files live in a per-run temporary directory, deleted by `discard` and by the stage's cleanup. Nothing
 * here throws on start for a missing ffmpeg: the video is skipped (and logged); the trace still records.
 */

export interface SessionRecordingOptions {
  video: boolean;
  trace: boolean;
  /** Where the per-run temporary directory is made (default: the OS temp dir). */
  baseDir?: string;
  /** ffmpeg's path; default: resolveFfmpegPath(). null: no video. */
  ffmpegPath?: string | null;
  /** The video's frame size (the screencast is scaled to fit, then padded). Default 1920×1080 (BROWSER_VIEWPORT). */
  size?: { width: number; height: number };
  logger?: { warn(obj: object, msg?: string): void };
}

const FPS = 25;
const STOP_TIMEOUT_MS = 15_000;

/**
 * ffmpeg for the video: FFMPEG_PATH, else Playwright's bundled one (registry lookup), when the file exists.
 * Null when neither is available.
 */
export async function resolveFfmpegPath(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const candidates: string[] = [];
  if (env.FFMPEG_PATH) candidates.push(env.FFMPEG_PATH);
  try {
    const require = createRequire(import.meta.url);
    const { registry } = require("playwright-core/lib/server/registry/index") as {
      registry: { findExecutable(name: string): { executablePath(lang: string): string | undefined } | undefined };
    };
    const bundled = registry.findExecutable("ffmpeg")?.executablePath("javascript");
    if (bundled) candidates.push(bundled);
  } catch {
    // an unexpected playwright-core layout: FFMPEG_PATH only
  }
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not there: next
    }
  }
  return null;
}

/** ffmpeg's arguments: MJPEG frames on stdin → VP8 WebM of a fixed size (Playwright's videoRecorder settings). */
export function ffmpegArgs(outputFile: string, size: { width: number; height: number }): string[] {
  const { width: w, height: h } = size;
  return [
    ...`-loglevel error -f image2pipe -avioflags direct -fpsprobesize 0 -probesize 32 -analyzeduration 0 -c:v mjpeg -i pipe:0 -y -an -r ${FPS}`.split(" "),
    ...`-c:v vp8 -qmin 0 -qmax 50 -crf 8 -deadline realtime -speed 8 -b:v 1M -threads 1`.split(" "),
    // Scaled to fit, then letterboxed in black: a frame of any size fills the picture as far as its shape allows.
    "-vf",
    `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:0:0:black`,
    outputFile,
  ];
}

/** A page that stays unchanged longer than this (waiting for a model call) is shown for this long only. */
export const MAX_STILL_SECONDS = 3;

/**
 * Frame pacing for a constant-rate video from screencast frames that arrive only when the page changes:
 * each frame is repeated for as long as it was on screen (at least once, at most MAX_STILL_SECONDS — so
 * the video skips the exploration's idle pauses and stays small).
 */
export function framesFor(durationSeconds: number): number {
  const seconds = Math.min(MAX_STILL_SECONDS, Math.max(0, Number.isFinite(durationSeconds) ? durationSeconds : 0));
  return Math.max(1, Math.round(FPS * seconds));
}

/** What Chromium says about a screencast frame: the size of the area it shows, in CSS pixels. */
interface FrameMetadata {
  timestamp?: number;
  deviceWidth?: number;
  deviceHeight?: number;
}

/**
 * A frame of a full-page screenshot, not of the screen: while a screenshot captures beyond the viewport (every
 * checkpoint's full-page screenshot), the screencast shows the whole page, e.g. 1905×6000, which the video would show
 * as a thin strip on gray (2026-10-07). Such a frame is much taller than any screen the video records; it is skipped,
 * and the screen before it stays on.
 */
export function isPageCaptureFrame(metadata: FrameMetadata, size: { width: number; height: number }): boolean {
  return (metadata.deviceHeight ?? 0) > size.height * 1.25;
}

/** After a full-page capture, how long the screen before it may stay on while the page gets its size back. */
export const CAPTURE_SETTLE_SECONDS = 1;

/**
 * Which screencast frames are the screen: not the frames of a full-page capture, nor, for up to
 * CAPTURE_SETTLE_SECONDS after one, frames smaller than the screen before it (the page at the window's size until its
 * viewport is set back) — the screen before the capture stays on instead.
 */
export class ScreenFrames {
  private screen: { width: number; height: number } | null = null;
  private captureAt: number | null = null;

  constructor(private readonly size: { width: number; height: number }) {}

  keep(metadata: FrameMetadata, at: number): boolean {
    if (isPageCaptureFrame(metadata, this.size)) {
      this.captureAt = at;
      return false;
    }
    const width = metadata.deviceWidth ?? 0;
    const height = metadata.deviceHeight ?? 0;
    if (this.captureAt !== null) {
      const smaller = this.screen !== null && (width < this.screen.width || height < this.screen.height);
      if (smaller && at - this.captureAt < CAPTURE_SETTLE_SECONDS) return false;
      this.captureAt = null;
    }
    this.screen = { width, height };
    return true;
  }
}

/** The page's screencast, encoded by ffmpeg. */
export class ScreencastVideo {
  private last: { frame: Buffer; at: number } | null = null;
  private writing: Promise<void> = Promise.resolve();
  private stopped = false;
  private exited: Promise<void>;

  private constructor(
    private readonly ffmpeg: ChildProcess,
    private readonly cdp: CDPSession,
    readonly outputFile: string,
  ) {
    this.exited = new Promise((resolve) => {
      ffmpeg.once("exit", () => resolve());
      ffmpeg.once("error", () => resolve());
    });
    ffmpeg.stdin?.on("error", () => {}); // ffmpeg gone: the video is simply shorter
  }

  static async start(page: Page, ffmpegPath: string, outputFile: string, size: { width: number; height: number } = BROWSER_VIEWPORT): Promise<ScreencastVideo> {
    const ffmpeg = spawn(ffmpegPath, ffmpegArgs(outputFile, size), { stdio: ["pipe", "ignore", "ignore"], env: { PATH: process.env.PATH ?? "" } });
    let cdp: CDPSession | undefined;
    try {
      cdp = await page.context().newCDPSession(page);
      const video = new ScreencastVideo(ffmpeg, cdp, outputFile);
      const screen = new ScreenFrames(size);
      cdp.on("Page.screencastFrame", (e: { data: string; sessionId: number; metadata: FrameMetadata }) => {
        cdp!.send("Page.screencastFrameAck", { sessionId: e.sessionId }).catch(() => {});
        const at = e.metadata.timestamp ?? Date.now() / 1000;
        if (screen.keep(e.metadata, at)) video.frame(Buffer.from(e.data, "base64"), at);
      });
      await cdp.send("Page.startScreencast", { format: "jpeg", quality: 80, maxWidth: size.width, maxHeight: size.height, everyNthFrame: 1 });
      return video;
    } catch (err) {
      await cdp?.detach().catch(() => {});
      ffmpeg.kill("SIGKILL");
      throw err;
    }
  }

  /** A frame shown from `at` (seconds): the previous one is written for as long as it was on screen. */
  private frame(frame: Buffer, at: number): void {
    if (this.stopped) return;
    const previous = this.last;
    this.last = { frame, at };
    if (previous) this.write(previous.frame, framesFor(at - previous.at));
  }

  private write(frame: Buffer, times: number): void {
    const stdin = this.ffmpeg.stdin;
    if (!stdin || stdin.destroyed) return;
    this.writing = this.writing.then(async () => {
      for (let i = 0; i < times; i++) {
        if (stdin.destroyed) return;
        await new Promise<void>((resolve) => stdin.write(frame, () => resolve()));
      }
    });
  }

  /** Stops the screencast, writes the last frame, lets ffmpeg finish the file. True when a video was written. */
  async stop(): Promise<boolean> {
    if (this.stopped) return false;
    await this.cdp.send("Page.stopScreencast").catch(() => {});
    await this.cdp.detach().catch(() => {});
    if (this.last) this.write(this.last.frame, framesFor(Date.now() / 1000 - this.last.at));
    this.stopped = true;
    const hadFrames = this.last !== null;
    await this.writing;
    this.ffmpeg.stdin?.end();
    const timer = setTimeout(() => this.ffmpeg.kill("SIGKILL"), STOP_TIMEOUT_MS);
    await this.exited;
    clearTimeout(timer);
    if (!hadFrames || this.ffmpeg.exitCode !== 0) return false;
    return (await stat(this.outputFile).catch(() => null))?.size ? true : false;
  }

  /** Stops without keeping anything. Idempotent. */
  async kill(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.cdp.send("Page.stopScreencast").catch(() => {});
    await this.cdp.detach().catch(() => {});
    this.ffmpeg.kill("SIGKILL");
    await this.exited;
  }
}

/**
 * Starts the run's recordings on `page` (the engine's `startRecording` port). Null when the run records
 * neither. A trace that cannot start throws (the stage logs it and explores without recordings).
 */
export async function startSessionRecording(ctx: Pick<StageContext, "runId" | "addCleanup">, page: Page, opts: SessionRecordingOptions): Promise<SessionRecording | null> {
  if (!opts.video && !opts.trace) return null;
  const dir = await mkdtemp(path.join(opts.baseDir ?? os.tmpdir(), `recording-${ctx.runId.replace(/[^\w-]/g, "_")}-`));
  const removeDir = () => rm(dir, { recursive: true, force: true }).catch(() => {});
  ctx.addCleanup(removeDir);

  let video: ScreencastVideo | null = null;
  let tracing = false;
  try {
    if (opts.trace) {
      await page.context().tracing.start({ screenshots: true, snapshots: true, title: "Exploration" });
      tracing = true;
    }
    if (opts.video) {
      const ffmpeg = opts.ffmpegPath === undefined ? await resolveFfmpegPath() : opts.ffmpegPath;
      if (ffmpeg) {
        video = await ScreencastVideo.start(page, ffmpeg, path.join(dir, "exploration.webm"), opts.size).catch((err: unknown) => {
          opts.logger?.warn({ err: err instanceof Error ? err.message : String(err), runId: ctx.runId }, "exploration video could not start; recording the trace only");
          return null;
        });
      } else {
        opts.logger?.warn({ runId: ctx.runId }, "no ffmpeg (FFMPEG_PATH, or Playwright's: playwright-core install chromium): exploration video skipped");
      }
    }
  } catch (err) {
    if (tracing) await page.context().tracing.stop().catch(() => {});
    await video?.kill();
    await removeDir();
    throw err;
  }
  if (!video && !tracing) {
    await removeDir();
    return null;
  }

  let done = false;
  return {
    async stop() {
      done = true;
      const files: Awaited<ReturnType<SessionRecording["stop"]>> = [];
      const errors: unknown[] = [];
      if (video) {
        try {
          if (await video.stop()) files.push({ type: "VIDEO", path: video.outputFile, contentType: "video/webm", fileName: "exploration.webm" });
        } catch (err) {
          errors.push(err);
        }
      }
      if (tracing) {
        const tracePath = path.join(dir, "exploration-trace.zip");
        try {
          await page.context().tracing.stop({ path: tracePath });
          tracing = false;
          files.push({ type: "TRACE", path: tracePath, contentType: "application/zip", fileName: "exploration-trace.zip" });
        } catch (err) {
          errors.push(err);
        }
      }
      if (files.length === 0 && errors.length > 0) throw errors[0];
      return files;
    },
    async discard() {
      if (!done) {
        done = true;
        await video?.kill().catch(() => {});
        if (tracing) await page.context().tracing.stop().catch(() => {});
      }
      await removeDir();
    },
  };
}
