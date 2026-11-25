import type { ClientLogBatch } from "@platform/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reportClientError, startClientLogReporter } from "./client-log-reporter";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const sent = () => {
  const batches: { runId: string; lines: ClientLogBatch["lines"] }[] = [];
  const send = vi.fn(async (runId: string, batch: ClientLogBatch) => void batches.push({ runId, lines: batch.lines }));
  return { batches, send };
};

describe("startClientLogReporter", () => {
  it("batches window errors and posts them", async () => {
    const { batches, send } = sent();
    const stop = startClientLogReporter("run_1", { send });
    window.dispatchEvent(new ErrorEvent("error", { message: "TypeError: x is undefined", error: new TypeError("x is undefined") }));
    const rejection = new Event("unhandledrejection") as Event & { reason: unknown };
    rejection.reason = new Error("promise broke");
    window.dispatchEvent(rejection);
    reportClientError("api", "The server answered 502.");
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.runId).toBe("run_1");
    expect(batches[0]!.lines.map((l) => [l.kind, l.message])).toEqual([
      ["error", "TypeError: x is undefined"],
      ["unhandledrejection", "promise broke"],
      ["api", "The server answered 502."],
    ]);
    expect(batches[0]!.lines[0]!.stack).toContain("x is undefined");
    expect(batches[0]!.lines[0]!.url).toBe(window.location.href);
    stop();
  });

  it("sends at 50 lines without waiting", async () => {
    const { batches, send } = sent();
    const stop = startClientLogReporter("run_1", { send });
    for (let i = 0; i < 50; i++) reportClientError("render", `e${i}`);
    await vi.advanceTimersByTimeAsync(0);
    expect(batches.map((b) => b.lines.length)).toEqual([50]);
    stop();
  });

  it("caps at 300 per page load", async () => {
    const { batches, send } = sent();
    const stop = startClientLogReporter("run_1", { send });
    for (let i = 0; i < 400; i++) reportClientError("render", `e${i}`);
    await vi.advanceTimersByTimeAsync(5000);
    expect(batches.reduce((n, b) => n + b.lines.length, 0)).toBe(300);
    stop();
  });

  it("a failed post is not reported again", async () => {
    const send = vi.fn(async () => {
      throw new Error("offline");
    });
    const stop = startClientLogReporter("run_1", { send });
    reportClientError("api", "boom");
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(send).toHaveBeenCalledTimes(1);
    stop();
  });

  it("reports nothing once stopped, and cuts long messages", async () => {
    const { batches, send } = sent();
    const stop = startClientLogReporter("run_1", { send });
    reportClientError("render", "m".repeat(5000));
    stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(batches[0]!.lines[0]!.message).toHaveLength(4096);
    reportClientError("render", "after");
    await vi.advanceTimersByTimeAsync(5000);
    expect(batches).toHaveLength(1);
  });
});

describe("failed API calls", () => {
  it("a 5xx or unreachable server is reported, a 4xx is not", async () => {
    const { getRun } = await import("./api");
    const { batches, send } = sent();
    const stop = startClientLogReporter("run_1", { send });
    const responses = [new Response("{}", { status: 502 }), new Response('{"code":"NOT_FOUND","message":"Not found"}', { status: 404 })];
    vi.stubGlobal("fetch", vi.fn(async () => {
      const next = responses.shift();
      if (!next) throw new TypeError("Failed to fetch");
      return next;
    }));
    await getRun("run_1").catch(() => {});
    await getRun("run_1").catch(() => {});
    await getRun("run_1").catch(() => {});
    stop();
    vi.unstubAllGlobals();
    expect(batches.flatMap((b) => b.lines.map((l) => [l.kind, l.message]))).toEqual([
      ["api", "GET /api/v1/test-runs/run_1: The server answered 502."],
      ["api", "GET /api/v1/test-runs/run_1: Could not reach the server. Check your connection and try again."],
    ]);
  });
});

describe("client-log batch size", () => {
  it("splits batches so no request body passes 60 KB", async () => {
    const { batches, send } = sent();
    const stop = startClientLogReporter("run_1", { send });
    for (let i = 0; i < 20; i++) reportClientError("render", `e${i}`, "s".repeat(16_000));
    await vi.advanceTimersByTimeAsync(5000);
    expect(batches.reduce((n, b) => n + b.lines.length, 0)).toBe(20);
    for (const b of batches) expect(JSON.stringify({ lines: b.lines }).length).toBeLessThanOrEqual(60_000);
    stop();
  });

  it("uses keepalive only for the last flush when the page goes away", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const stop = startClientLogReporter("run_1");
    reportClientError("render", "during");
    await vi.advanceTimersByTimeAsync(5000);
    reportClientError("render", "at the end");
    stop();
    vi.unstubAllGlobals();
    const init = (i: number) => (fetch.mock.calls[i] as unknown as [string, RequestInit])[1];
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(init(0).keepalive).toBeFalsy();
    expect(init(1).keepalive).toBe(true);
  });
});
