import type { LlmChoice, LlmKeyProvider } from "@platform/contracts";
import type { DiscoveryAdmission } from "@platform/config";
import type { Database } from "@platform/db";
import type { RunEventHub, RunQueue, ScheduleSync, RevisionQueue } from "@platform/event-bus";
import type { Resolver } from "@platform/security";
import type { ArtifactStorage } from "@platform/storage";
import type { Redis } from "ioredis";
import type { TokenThrottle } from "./auth/principal";
import type { ApiMetrics } from "./metrics";
import type { CancelSignal } from "./services/cancel-signal";
import type { LoginThrottle } from "./services/user-service";

export interface ApiConfig {
  apiToken: string;
  defaultTenantId: string;
  maxActiveRunsPerTenant: number;
  privateAllowlist: string[];
  discovery?: DiscoveryAdmission;
  verifiedDiscoverySites?: boolean;
  /** Live sites: Browser Use may interact with the real site (the broker's inspecting egress proxy). */
  liveDiscoveryInteraction?: boolean;
  secretsKey: Buffer;
  /** Signed artifact URL lifetime; capped at 300 s. */
  artifactUrlTtlSeconds: number;
  sseHeartbeatMs: number;
  /** The LLM_* environment, which the API shares with the worker (compose's x-app-env). */
  llm: ApiLlmConfig;
  /** Users and sessions (V1.1 F1). */
  auth: ApiAuthConfig;
  /** SCHEDULE_MIN_INTERVAL_MINUTES (V1.2 F3); unset: 15. */
  scheduleMinIntervalMinutes?: number;
  /** RUN_LOG_RETENTION_DAYS (admin run logs); unset: 14. */
  runLogRetentionDays?: number;
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
  assistanceRedis?: Pick<Redis, "get" | "eval">;
  discoveryRollout?: Pick<Redis, "get" | "set" | "del">;
  hub: RunEventHub;
  queue: RunQueue;
  /** Rewrites a check from the user's words on the worker (2026-11-19); unset: 503 REVISE_UNAVAILABLE. */
  revisions?: RevisionQueue;
  storage: ArtifactStorage;
  cancelSignal: CancelSignal;
  resolve: Resolver;
  /** Receives every audit entry after it is logged and stored (tests; an external sink). */
  audit?: (entry: Record<string, unknown>) => void;
  /** Failed-login counter; unset: a process-local one. */
  loginThrottle?: LoginThrottle;
  metrics?: ApiMetrics;
  /** BullMQ's job schedulers for suite schedules (V1.2 F3); unset: schedules are stored but never fire. */
  schedules?: ScheduleSync;
  /** API tokens' hourly request count (V1.2 F4); unset: a process-local one. */
  tokenThrottle?: TokenThrottle;
  /** The API's own logger: its run lines (and one line per request to a run's routes) reach the run logs. */
  logger?: { info(obj: object, msg?: string): void };
  /** The clock (tests). */
  now?: () => Date;
}
