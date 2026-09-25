import type { Database } from "@platform/db";
import type { RunEventHub, RunQueue } from "@platform/event-bus";
import type { Resolver } from "@platform/security";
import type { ArtifactStorage } from "@platform/storage";
import type { Redis } from "ioredis";
import type { CancelSignal } from "./services/cancel-signal";

export interface ApiConfig {
  apiToken: string;
  defaultTenantId: string;
  maxActiveRunsPerTenant: number;
  privateAllowlist: string[];
  secretsKey: Buffer;
  /** Signed artifact URL lifetime; capped at 300 s. */
  artifactUrlTtlSeconds: number;
  sseHeartbeatMs: number;
}

export interface ApiDeps {
  config: ApiConfig;
  db: Database;
  /** Publishing connection (events + cancel signals). */
  redis: Pick<Redis, "publish">;
  hub: RunEventHub;
  queue: RunQueue;
  storage: ArtifactStorage;
  cancelSignal: CancelSignal;
  resolve: Resolver;
  audit?: (entry: Record<string, unknown>) => void;
}
