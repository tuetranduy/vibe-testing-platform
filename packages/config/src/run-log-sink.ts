import {
  RunLifecycleSchema,
  RunLogLevelSchema,
  RunLogSourceSchema,
  type RunLifecycle,
  type RunLogLevel,
  type RunLogSource,
} from "@platform/contracts";

/** What the sink hands its writer (structurally @platform/db's NewRunLogLine; config does not depend on db). */
export interface SinkLine {
  runId: string;
  time: Date;
  source: RunLogSource;
  level: RunLogLevel;
  stage: RunLifecycle | null;
  component: string;
  message: string;
  fields: Record<string, unknown>;
}

export type RunLogDropReason = "buffer_full" | "cap" | "insert_failed";

export interface RunLogSinkOptions {
  /** The process's logger component: the default source for `worker` / `api` / `runner`. */
  component: string;
  write(lines: SinkLine[]): Promise<void>;
  /** Default 20000. Past it a run keeps only warn and above. */
  maxLinesPerRun?: number;
  /** Default 500 ms. */
  flushMs?: number;
  /** Default 200 lines. */
  batchSize?: number;
  /** Default 5000 lines across runs. */
  bufferLimit?: number;
  onDrop?(reason: RunLogDropReason, n: number): void;
  onWriteError?(err: unknown): void;
}

export interface RunLogSink {
  /** For `LoggerOptions.sink`: never throws. */
  accept(record: Record<string, unknown>): void;
  flush(): Promise<void>;
  /** Flushes, stops the timer; later lines are ignored. */
  close(): Promise<void>;
}

const MAX_STRING = 16_384;
const OMIT = new Set(["level", "time", "component", "msg", "runId", "stage", "source", "tenantId"]);
const PROCESS_SOURCES = new Set<string>(["worker", "api", "runner"]);
const LOW_LEVELS = new Set<string>(["trace", "debug", "info"]);
/** Per-run line counts kept for this many runs (oldest forgotten first). */
const MAX_TRACKED_RUNS = 5000;

/** Cuts at MAX_STRING, one code unit earlier when that would split a surrogate pair (an emoji). */
function cut(s: string): string {
  if (s.length <= MAX_STRING) return s;
  const last = s.charCodeAt(MAX_STRING - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? MAX_STRING - 1 : MAX_STRING;
  return `${s.slice(0, end)}…[truncated ${s.length - end} chars]`;
}

/** Long strings cut; a value inside itself becomes "[Circular]" (the logger's redaction keeps cycles). */
function truncate(value: unknown, ancestors: object[] = []): unknown {
  if (typeof value === "string") return cut(value);
  if (!value || typeof value !== "object") return value;
  if (ancestors.includes(value)) return "[Circular]";
  const path = [...ancestors, value];
  if (Array.isArray(value)) return value.map((v) => truncate(v, path));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, truncate(v, path)]));
}

/** `record.source` when it is a known source, else the process (`worker` / `api` / `runner`), else `worker`. */
export function classifySource(record: Record<string, unknown>, component: string): RunLogSource {
  const own = RunLogSourceSchema.safeParse(record.source);
  if (own.success) return own.data;
  const c = typeof record.component === "string" ? record.component : component;
  return PROCESS_SOURCES.has(c) ? (c as RunLogSource) : PROCESS_SOURCES.has(component) ? (component as RunLogSource) : "worker";
}

function toLine(record: Record<string, unknown>, component: string): SinkLine | null {
  if (typeof record.runId !== "string" || record.runId.length === 0) return null;
  const level = RunLogLevelSchema.safeParse(record.level);
  const stage = RunLifecycleSchema.safeParse(record.stage);
  const time = new Date(typeof record.time === "string" ? record.time : Date.now());
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) if (!OMIT.has(k)) fields[k] = truncate(v);
  return {
    runId: record.runId,
    time: Number.isNaN(time.getTime()) ? new Date() : time,
    source: classifySource(record, component),
    level: level.success ? level.data : "info",
    stage: stage.success ? stage.data : null,
    component: typeof record.component === "string" ? record.component : component,
    message: cut(typeof record.msg === "string" ? record.msg : ""),
    fields,
  };
}

/**
 * Admin run logs (2026-11-25): a bounded, batched, never-throwing destination for every log line that names a
 * run. A slow or failing database costs log lines (counted through `onDrop`), never the run.
 */
export function createRunLogSink(opts: RunLogSinkOptions): RunLogSink {
  const maxPerRun = opts.maxLinesPerRun ?? 20_000;
  const batchSize = opts.batchSize ?? 200;
  const bufferLimit = opts.bufferLimit ?? 5000;
  const buffer: SinkLine[] = [];
  const counts = new Map<string, { n: number; capped: boolean }>();
  let chain: Promise<void> = Promise.resolve();
  let closed = false;

  const drop = (reason: RunLogDropReason, n: number) => {
    try {
      opts.onDrop?.(reason, n);
    } catch {
      // a metrics failure is not the run's problem
    }
  };

  const enqueue = (line: SinkLine) => {
    if (buffer.length >= bufferLimit) {
      const low = buffer.findIndex((l) => LOW_LEVELS.has(l.level));
      buffer.splice(low >= 0 ? low : 0, 1);
      drop("buffer_full", 1);
    }
    buffer.push(line);
    if (buffer.length >= batchSize) void flush();
  };

  const countFor = (runId: string) => {
    let c = counts.get(runId);
    if (!c) {
      if (counts.size >= MAX_TRACKED_RUNS) counts.delete(counts.keys().next().value!);
      c = { n: 0, capped: false };
      counts.set(runId, c);
    }
    return c;
  };

  async function writeAll(): Promise<void> {
    while (buffer.length > 0) {
      const batch = buffer.splice(0, batchSize);
      try {
        await opts.write(batch);
      } catch (err) {
        try {
          opts.onWriteError?.(err);
        } catch {
          // ignored
        }
        // One line the database refuses must not cost the others (other runs' lines included): retry one by one.
        // Three refusals in a row means the database is down, not one bad line: the rest are dropped.
        let failed = batch.length;
        if (batch.length > 1) {
          failed = 0;
          let inARow = 0;
          for (const [i, line] of batch.entries()) {
            if (inARow >= 3) {
              failed += batch.length - i;
              break;
            }
            try {
              await opts.write([line]);
              inARow = 0;
            } catch {
              failed += 1;
              inARow += 1;
            }
          }
        }
        if (failed > 0) drop("insert_failed", failed);
      }
    }
  }

  function flush(): Promise<void> {
    chain = chain.then(writeAll, writeAll);
    return chain;
  }

  const timer = setInterval(() => void flush(), opts.flushMs ?? 500);
  timer.unref?.();

  return {
    accept(record) {
      if (closed) return;
      try {
        const line = toLine(record, opts.component);
        if (!line) return;
        const c = countFor(line.runId);
        if (c.n >= maxPerRun && LOW_LEVELS.has(line.level)) {
          drop("cap", 1);
          if (!c.capped) {
            c.capped = true;
            enqueue({
              ...line,
              source: "infra",
              level: "warn",
              component: opts.component,
              message: "run log line cap reached",
              fields: { maxLinesPerRun: maxPerRun },
            });
          }
          return;
        }
        c.n += 1;
        enqueue(line);
      } catch {
        // never into the caller
      }
    },
    flush,
    async close() {
      closed = true;
      clearInterval(timer);
      await flush();
    },
  };
}
