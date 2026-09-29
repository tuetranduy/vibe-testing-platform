import type { LlmChoice, LlmKeyProvider } from "@platform/contracts";
import type { Database } from "@platform/db";
import type { RunEventHub, RunQueue } from "@platform/event-bus";
import type { Resolver } from "@platform/security";
import type { ArtifactStorage } from "@platform/storage";
import type { Redis } from "ioredis";
import type { ApiMetrics } from "./metrics";
import type { CancelSignal } from "./services/cancel-signal";
import type { LoginThrottle } from "./services/user-service";

export interface ApiConfig {
  apiToken: string;
  defaultTenantId: string;
  maxActiveRunsPerTenant: number;
  privateAllowlist: string[];
  secretsKey: Buffer;
  /** Signed artifact URL lifetime; capped at 300 s. */
  artifactUrlTtlSeconds: number;
  sseHeartbeatMs: number;
  /** The LLM_* environment, which the API shares with the worker (compose's x-app-env). */
  llm: ApiLlmConfig;
  /** Users and sessions (V1.1 F1). */
  auth: ApiAuthConfig;
}

export interface ApiAuthConfig {
  /** SESSION_TTL_HOURS: a session's fixed lifetime. */
  sessionTtlHours: number;
  /** scrypt cost for new password hashes; unset: the default (2^15). Tests lower it. */
  passwordHashN?: number;
}

export interface ApiLlmConfig {
  envChoice: LlmChoice;
  envKeys: Record<LlmKeyProvider, boolean>;
  fakeAllowed: boolean;
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
  /** Receives every audit entry after it is logged and stored (tests; an external sink). */
  audit?: (entry: Record<string, unknown>) => void;
  /** Failed-login counter; unset: a process-local one. */
  loginThrottle?: LoginThrottle;
  metrics?: ApiMetrics;
}
