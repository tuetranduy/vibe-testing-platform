import type { RunLogRegistry } from "@platform/config";
import type { Database } from "@platform/db";
import type { RunQueue } from "@platform/event-bus";
import type { ArtifactStorage } from "@platform/storage";
import type { Redis } from "ioredis";
import type { CancelWatcher } from "./cancel-watcher";
import type { Engines } from "./engine";
import type { WorkerMetrics } from "./metrics";
import type { RunLlmFactory } from "./run-llm";

export interface WorkerLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface WorkerConfig {
  secretsKey: Buffer;
  analysisTimeoutSeconds: number;
  heartbeatMs: number;
  /** A run whose heartbeat is older than this is considered lost (WORKER_LOST). */
  staleAfterMs: number;
  confirmationTtlHours: number;
  /** A QUEUED run older than this whose analyze job isn't pending was never picked up. */
  queuedStaleAfterMs: number;
  /** Grace after `deadlineAt` before the reaper times out a run whose worker didn't. */
  deadlineGraceMs: number;
  /** Multiplies every run-time budget; 1 in production, tiny in tests. */
  timeScale: number;
}

export interface WorkerDeps {
  config: WorkerConfig;
  db: Database;
  redis: Pick<Redis, "publish">;
  cancelWatcher: CancelWatcher;
  queue: RunQueue;
  /** Both engines; each run uses the one its model choice names (`engines.for(choice)`). */
  engines: Engines;
  /** Builds each run's model client from its recorded choice (createRunContext). */
  runLlm: RunLlmFactory;
  logger: WorkerLogger;
  /** Active runs' log scopes (tenant, stage, run redactor); see createLogger in @platform/config. */
  runLogs?: RunLogRegistry;
  /** Prometheus metrics; absent in most tests. */
  metrics?: WorkerMetrics;
  /** Artifact storage; when set, the daily retention job runs. */
  storage?: ArtifactStorage;
  now?: () => Date;
}

export const silentLogger: WorkerLogger = { info() {}, warn() {}, error() {} };
