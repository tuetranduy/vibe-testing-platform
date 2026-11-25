import { createLogger, createRunLogRegistry, createRunLogSink, type LogLevel, type RunLogRegistry, type RunLogSink } from "@platform/config";
import { RunLogRepository, type Database } from "@platform/db";
import type { WorkerLogger } from "./deps";
import type { WorkerMetrics } from "./metrics";

export interface WorkerLoggingOptions {
  level: LogLevel;
  /** RUN_LOG_MAX_LINES. */
  maxLinesPerRun: number;
  metrics?: WorkerMetrics;
  component?: string;
  /** Test seam: stdout. */
  write?: (line: string) => void;
}

export interface WorkerLogging {
  logger: WorkerLogger;
  runLogs: RunLogRegistry;
  sink: RunLogSink;
  /** Lines are stored from here on; before it they reach stdout only. */
  attachDb(db: Database): void;
}

/** How often a failing log store is reported on stdout. */
const WRITE_ERROR_EVERY_MS = 60_000;

/**
 * The process logger (JSON lines on stdout) plus the admin run logs: every line that names a run is also
 * stored in `run_logs` (2026-11-25). A failing store costs lines, counted in `run_log_dropped_total`.
 */
export function createWorkerLogging(opts: WorkerLoggingOptions): WorkerLogging {
  const component = opts.component ?? "worker";
  let repo: RunLogRepository | null = null;
  let lastReported = 0;
  // Declared first: the sink reports its own write errors through it (a line without runId, so not stored).
  let logger: WorkerLogger | null = null;
  const sink = createRunLogSink({
    component,
    maxLinesPerRun: opts.maxLinesPerRun,
    write: async (lines) => {
      if (repo) await repo.appendMany(lines);
    },
    onDrop: (reason, n) => opts.metrics?.runLogDropped.inc({ reason }, n),
    onWriteError: (err) => {
      if (Date.now() - lastReported < WRITE_ERROR_EVERY_MS) return;
      lastReported = Date.now();
      logger?.warn({ err }, "run log lines could not be stored; they are on stdout only");
    },
  });
  const runLogs = createRunLogRegistry();
  logger = createLogger({ component, level: opts.level, runs: runLogs, sink: sink.accept, ...(opts.write ? { write: opts.write } : {}) });
  return {
    logger,
    runLogs,
    sink,
    attachDb(db) {
      repo = new RunLogRepository(db);
    },
  };
}
