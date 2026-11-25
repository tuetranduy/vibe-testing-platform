import type { ClientLogBatch, ClientLogLine } from "@platform/contracts";

type Kind = ClientLogLine["kind"];
type Send = (runId: string, batch: ClientLogBatch, opts: { keepalive: boolean }) => Promise<void>;

const FLUSH_MS = 5000;
const BATCH = 50;
/** Lines one page load sends at most (the API keeps 300 per person per run). */
const MAX_PER_PAGE_LOAD = 300;
const MAX_MESSAGE = 4096;
const MAX_STACK = 16_384;
/** A request body stays under this: browsers refuse `keepalive` bodies over 64 KiB (shared by all in flight). */
const MAX_BODY = 60_000;

interface Reporter {
  report(kind: Kind, message: string, stack?: string): void;
}

let active: Reporter | null = null;

/**
 * Reports a frontend error of our web app to the run whose page is open (admin run logs, 2026-11-25). Does
 * nothing when no run page is open.
 */
export function reportClientError(kind: Kind, message: string, stack?: string): void {
  active?.report(kind, message, stack);
}

async function postClientLogs(runId: string, batch: ClientLogBatch, { keepalive }: { keepalive: boolean }): Promise<void> {
  // Plain fetch, not lib/api's request(): a failure here must never be reported as another error.
  const res = await fetch(`/api/v1/test-runs/${encodeURIComponent(runId)}/client-logs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(batch),
    // Only the last flush, as the page goes away, needs to outlive it.
    ...(keepalive ? { keepalive: true } : {}),
  });
  if (!res.ok) throw new Error(`client logs answered ${res.status}`);
}

const messageOf = (reason: unknown) => (reason instanceof Error ? reason.message : typeof reason === "string" ? reason : String(reason));

/**
 * While a run's page is open: window errors, unhandled rejections and `reportClientError` calls, batched every 5 s
 * or at 50, at most 300 per page load. Failed posts are dropped, never retried or reported. Returns `stop`, which
 * sends what is left.
 */
export function startClientLogReporter(runId: string, opts: { send?: Send } = {}): () => void {
  const send = opts.send ?? postClientLogs;
  let queue: ClientLogLine[] = [];
  let accepted = 0;
  let stopped = false;

  /** Sends the queue in batches of at most 50 lines and 60 KB. */
  const flush = (keepalive = false) => {
    while (queue.length > 0) {
      const lines: ClientLogLine[] = [];
      let size = 12; // {"lines":[]}
      while (queue.length > 0 && lines.length < BATCH) {
        const next = JSON.stringify(queue[0]).length + 1;
        if (lines.length > 0 && size + next > MAX_BODY) break;
        lines.push(queue.shift()!);
        size += next;
      }
      void send(runId, { lines }, { keepalive }).catch(() => {});
    }
  };

  const reporter: Reporter = {
    report(kind, message, stack) {
      if (stopped || accepted >= MAX_PER_PAGE_LOAD) return;
      accepted += 1;
      queue.push({
        time: new Date().toISOString(),
        level: "error",
        message: (message || "Unknown error").slice(0, MAX_MESSAGE),
        url: window.location.href.slice(0, 2048),
        kind,
        ...(stack ? { stack: stack.slice(0, MAX_STACK) } : {}),
      });
      if (queue.length >= BATCH) flush();
    },
  };

  const onError = (e: ErrorEvent) => reporter.report("error", e.message || messageOf(e.error), e.error instanceof Error ? e.error.stack : undefined);
  const onRejection = (e: PromiseRejectionEvent | (Event & { reason?: unknown })) => {
    const reason = (e as { reason?: unknown }).reason;
    reporter.report("unhandledrejection", messageOf(reason), reason instanceof Error ? reason.stack : undefined);
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection as EventListener);
  const timer = setInterval(() => flush(), FLUSH_MS);
  const onPageHide = () => flush(true);
  window.addEventListener("pagehide", onPageHide);
  active = reporter;

  return () => {
    if (stopped) return;
    flush(true);
    window.removeEventListener("pagehide", onPageHide);
    stopped = true;
    queue = [];
    clearInterval(timer);
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection as EventListener);
    if (active === reporter) active = null;
  };
}
