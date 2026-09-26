import { TestEventSchema, isTerminalEvent, type TestEvent } from "@platform/contracts";
import { runEventsPath } from "./api";

export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "closed" | "failed";

export interface RunEventsOptions {
  runId: string;
  onEvent: (event: TestEvent) => void;
  onStatus?: (status: ConnectionStatus) => void;
  /** Resume after this sequence (0 = replay the run's whole history). */
  afterSequence?: number;
  /**
   * Called before reconnecting after a connection that opened but delivered no new events (e.g. a
   * terminal run whose stream ends at once). Return false to stop.
   */
  shouldReconnect?: () => boolean | Promise<boolean>;
  backoff?: { initialMs?: number; maxMs?: number };
  fetch?: typeof fetch;
  /** Test seam for the backoff wait. */
  delay?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface RunEventsConnection {
  close(): void;
  readonly latestSequence: number;
  /** Settles when the client stops for good (terminal event, close(), or a non-retryable error). */
  readonly done: Promise<void>;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

interface SseFrame {
  id: string | null;
  event: string | null;
  data: string;
}

/** Minimal text/event-stream parser: yields a frame per blank line; comments and `retry:` are ignored. */
async function* frames(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let frame: SseFrame = { id: null, event: null, data: "" };
  let hasData = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.search(/\r\n|\r|\n/)) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + (buffer.startsWith("\r\n", nl) ? 2 : 1));
        if (line === "") {
          if (hasData) yield frame;
          frame = { id: null, event: null, data: "" };
          hasData = false;
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "data") {
          frame.data = hasData ? `${frame.data}\n${value}` : value;
          hasData = true;
        } else if (field === "id") frame.id = value;
        else if (field === "event") frame.event = value;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

class FatalError extends Error {}

/**
 * Follows a run's event stream through the web proxy. Delivers each event once, in sequence order;
 * after a disconnect it reconnects (with backoff) sending `Last-Event-ID: <latestSequence>`, so the
 * API backfills exactly what was missed. Stops after the run's terminal event.
 */
export function connectRunEvents(opts: RunEventsOptions): RunEventsConnection {
  const doFetch = opts.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const delay = opts.delay ?? sleep;
  const initialMs = opts.backoff?.initialMs ?? 500;
  const maxMs = opts.backoff?.maxMs ?? 10_000;
  const controller = new AbortController();
  let latestSequence = opts.afterSequence ?? 0;
  let status: ConnectionStatus | null = null;
  const setStatus = (s: ConnectionStatus) => {
    if (s === status) return;
    status = s;
    opts.onStatus?.(s);
  };

  /** One connection. Returns true when the terminal event arrived; `delivered` counts new events. */
  async function once(counter: { opened: boolean; delivered: number }): Promise<boolean> {
    const headers: Record<string, string> = { accept: "text/event-stream" };
    if (latestSequence > 0) headers["last-event-id"] = String(latestSequence);
    const res = await doFetch(runEventsPath(opts.runId), { headers, cache: "no-store", signal: controller.signal });
    if (!res.ok || !res.body) {
      // 5xx and 429 are worth retrying; anything else (404 unknown run, 400, 401) will not change.
      if (res.status >= 500 || res.status === 429) throw new Error(`HTTP ${res.status}`);
      throw new FatalError(`HTTP ${res.status}`);
    }
    counter.opened = true;
    setStatus("open");
    for await (const f of frames(res.body)) {
      let parsed: ReturnType<typeof TestEventSchema.safeParse>;
      try {
        parsed = TestEventSchema.safeParse(JSON.parse(f.data));
      } catch {
        continue;
      }
      if (!parsed.success) continue;
      const e = parsed.data;
      if (e.sequence <= latestSequence) continue; // duplicate from a backfill, or out of order
      latestSequence = e.sequence;
      counter.delivered++;
      opts.onEvent(e);
      if (isTerminalEvent(e)) return true;
    }
    return false;
  }

  async function run(): Promise<void> {
    let wait = initialMs;
    setStatus("connecting");
    while (!controller.signal.aborted) {
      const counter = { opened: false, delivered: 0 };
      try {
        if (await once(counter)) break;
      } catch (err) {
        if (controller.signal.aborted) break;
        if (err instanceof FatalError) {
          setStatus("failed");
          controller.abort();
          return;
        }
      }
      if (controller.signal.aborted) break;
      if (counter.delivered > 0) wait = initialMs;
      // A stream that opened and ended with nothing new may belong to a run that is over.
      else if (counter.opened && opts.shouldReconnect && !(await opts.shouldReconnect())) break;
      setStatus("reconnecting");
      await delay(wait, controller.signal);
      if (counter.delivered === 0) wait = Math.min(wait * 2, maxMs);
    }
    controller.abort();
    setStatus("closed");
  }

  const done = run().catch(() => setStatus("closed"));

  return {
    close: () => controller.abort(),
    get latestSequence() {
      return latestSequence;
    },
    done,
  };
}
