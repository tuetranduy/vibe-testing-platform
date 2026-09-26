// @vitest-environment node
import type { TestEvent } from "@platform/contracts";
import { describe, expect, it, vi } from "vitest";
import { ev, sseFrame } from "../test/events";
import { connectRunEvents, type ConnectionStatus } from "./run-events";

/** A fake SSE transport: each fetch call gets its own stream the test writes to and closes. */
function fakeTransport() {
  const enc = new TextEncoder();
  const connections: {
    url: string;
    headers: Headers;
    signal: AbortSignal | undefined;
    write: (s: string) => void;
    end: () => void;
    fail: (e: Error) => void;
  }[] = [];
  const pending: ((c: (typeof connections)[number]) => void)[] = [];
  const responders: (() => Response | Promise<Response>)[] = [];

  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const override = responders.shift()?.();
    if (override) return override;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
    const conn = {
      url: String(input),
      headers: new Headers(init?.headers),
      signal: init?.signal ?? undefined,
      write: (s: string) => controller.enqueue(enc.encode(s)),
      end: () => controller.close(),
      fail: (e: Error) => controller.error(e),
    };
    init?.signal?.addEventListener("abort", () => {
      try {
        controller.error(new DOMException("aborted", "AbortError"));
      } catch {
        /* already closed */
      }
    });
    connections.push(conn);
    pending.shift()?.(conn);
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  });

  /** Resolves with the n-th connection (0-based) once it's open. */
  const connection = (n: number) =>
    connections[n] ? Promise.resolve(connections[n]!) : new Promise<(typeof connections)[number]>((r) => pending.push(r));

  return { fetch, connections, connection, respondOnce: (fn: () => Response | Promise<Response>) => responders.push(fn) };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(check: () => boolean, tries = 50) {
  for (let i = 0; i < tries && !check(); i++) await tick();
  expect(check()).toBe(true);
}

const started = (seq: number) => ev(seq, "stage.started", { stage: "EXPLORING" });

function setup(
  extra: Partial<Parameters<typeof connectRunEvents>[0]> = {},
  responders: (() => Response | Promise<Response>)[] = [],
) {
  const t = fakeTransport();
  responders.forEach((r) => t.respondOnce(r)); // before connecting: the first fetch is immediate
  const events: TestEvent[] = [];
  const statuses: ConnectionStatus[] = [];
  const delays: number[] = [];
  const conn = connectRunEvents({
    runId: "run_1",
    fetch: t.fetch as unknown as typeof fetch,
    onEvent: (e) => events.push(e),
    onStatus: (s) => statuses.push(s),
    delay: async (ms) => void delays.push(ms),
    ...extra,
  });
  return { t, events, statuses, delays, conn };
}

describe("connectRunEvents", () => {
  it("connects to the run's event stream through the proxy and tracks latestSequence", async () => {
    const { t, events, conn } = setup();
    const c = await t.connection(0);
    expect(c.url).toBe("/api/v1/test-runs/run_1/events");
    expect(c.headers.get("accept")).toBe("text/event-stream");
    expect(c.headers.has("last-event-id")).toBe(false);

    c.write(": connected\n\n");
    c.write(sseFrame(started(1)) + sseFrame(started(2)));
    await until(() => events.length === 2);
    expect(conn.latestSequence).toBe(2);
    conn.close();
  });

  it("parses frames split across chunks", async () => {
    const { t, events, conn } = setup();
    const c = await t.connection(0);
    const frame = sseFrame(started(1));
    c.write(frame.slice(0, 10));
    c.write(frame.slice(10, 40));
    await tick();
    expect(events).toHaveLength(0);
    c.write(frame.slice(40));
    await until(() => events.length === 1);
    expect(events[0]!.sequence).toBe(1);
    conn.close();
  });

  it("on disconnect reconnects with Last-Event-ID and skips duplicates", async () => {
    const { t, events, statuses, conn } = setup();
    const first = await t.connection(0);
    first.write(sseFrame(started(1)) + sseFrame(started(2)));
    await until(() => events.length === 2);
    first.end(); // server / network dropped the connection

    const second = await t.connection(1);
    expect(second.headers.get("last-event-id")).toBe("2");
    expect(statuses).toContain("reconnecting");
    second.write(sseFrame(started(2)) + sseFrame(started(3))); // 2 is a duplicate from the backfill
    await until(() => events.length === 3);
    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(conn.latestSequence).toBe(3);
    conn.close();
  });

  it("reconnects after a network error with growing backoff, reset once events flow again", async () => {
    const { t, events, delays, conn } = setup({ backoff: { initialMs: 100, maxMs: 1000 } }, [
      () => Promise.reject(new TypeError("network down")),
      () => new Response("{}", { status: 503 }),
    ]);
    const c = await t.connection(0); // third fetch call is a real stream
    expect(t.fetch).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([100, 200]);
    c.write(sseFrame(started(1)));
    await until(() => events.length === 1);
    c.fail(new TypeError("connection reset"));
    await t.connection(1);
    expect(delays).toEqual([100, 200, 100]);
    conn.close();
  });

  it("stops after a terminal event", async () => {
    const { t, events, statuses, conn } = setup();
    const c = await t.connection(0);
    c.write(sseFrame(started(1)) + sseFrame(ev(2, "run.completed", { verdict: "PASSED" }, { stage: "COMPLETED" })));
    await conn.done;
    await tick();
    expect(events.map((e) => e.type)).toEqual(["stage.started", "run.completed"]);
    expect(statuses.at(-1)).toBe("closed");
    expect(t.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry a run that doesn't exist", async () => {
    const { t, statuses, conn } = setup({}, [
      () => new Response(JSON.stringify({ code: "NOT_FOUND", message: "Not found" }), { status: 404 }),
    ]);
    await conn.done;
    expect(statuses.at(-1)).toBe("failed");
    expect(t.fetch).toHaveBeenCalledTimes(1);
  });

  it("asks before reconnecting after a connection that delivered nothing new", async () => {
    const shouldReconnect = vi.fn(async () => false);
    const { t, statuses, conn } = setup({ shouldReconnect, afterSequence: 5 });
    const c = await t.connection(0);
    expect(c.headers.get("last-event-id")).toBe("5");
    c.end();
    await conn.done;
    expect(shouldReconnect).toHaveBeenCalledTimes(1);
    expect(statuses.at(-1)).toBe("closed");
    expect(t.fetch).toHaveBeenCalledTimes(1);
  });

  it("ignores frames that are not valid events", async () => {
    const { t, events, conn } = setup();
    const c = await t.connection(0);
    c.write("event: stage.started\ndata: {not json}\n\n");
    c.write(`id: 9\nevent: x\ndata: ${JSON.stringify({ type: "made.up", sequence: 9 })}\n\n`);
    c.write(sseFrame(started(1)));
    await until(() => events.length === 1);
    expect(conn.latestSequence).toBe(1);
    conn.close();
  });

  it("close() aborts the open request and does not reconnect", async () => {
    const { t, statuses, conn } = setup();
    const c = await t.connection(0);
    conn.close();
    await conn.done;
    expect(c.signal?.aborted).toBe(true);
    expect(statuses.at(-1)).toBe("closed");
    expect(t.fetch).toHaveBeenCalledTimes(1);
  });
});
