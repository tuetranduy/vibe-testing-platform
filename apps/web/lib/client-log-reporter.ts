import type { ClientLogBatch, ClientLogLine } from "@platform/contracts";

type Kind = ClientLogLine["kind"];
type Send = (runId: string, batch: ClientLogBatch) => Promise<void>;

const FLUSH_MS = 5000;
const BATCH = 50;
/** Lines one page load sends at most (the API keeps 300 per person per run). */
const MAX_PER_PAGE_LOAD = 300;
const MAX_MESSAGE = 4096;
const MAX_STACK = 16_384;

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

async function postClientLogs(runId: string, batch: ClientLogBatch): Promise<void> {
  // Plain fetch, not lib/api's request(): a failure here must never be reported as another error.
  const res = await fetch(`/api/v1/test-runs/${encodeURIComponent(runId)}/client-logs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(batch),
    keepalive: true,
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

  const flush = () => {
    if (queue.length === 0) return;
    const lines = queue.splice(0, BATCH);
    void send(runId, { lines }).catch(() => {});
    if (queue.length > 0) flush();
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
  const timer = setInterval(flush, FLUSH_MS);
  active = reporter;

  return () => {
    if (stopped) return;
    flush();
    stopped = true;
    queue = [];
    clearInterval(timer);
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection as EventListener);
    if (active === reporter) active = null;
  };
}
