import type { Database } from "@platform/db";
import type { RunQueue } from "@platform/event-bus";
import type { EngineStages } from "@platform/testing-engine";
import type { Redis } from "ioredis";
import type { CancelWatcher } from "./cancel-watcher";

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
  /** Multiplies every run-time budget; 1 in production, tiny in tests. */
  timeScale: number;
}

export interface WorkerDeps {
  config: WorkerConfig;
  db: Database;
  redis: Pick<Redis, "publish">;
  cancelWatcher: CancelWatcher;
  queue: RunQueue;
  stages: EngineStages;
  logger: WorkerLogger;
  now?: () => Date;
}

export const silentLogger: WorkerLogger = { info() {}, warn() {}, error() {} };
