import { z } from "zod";
import { HttpUrlSchema } from "./common";

const version = z.literal("discovery.v1");
const runId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
export const DiscoverySecondsSchema = z.number().int().min(15).max(120);
/** A broker job's whole wall-clock budget: container start, the agent and result delivery. */
export const DiscoveryJobSecondsSchema = z.number().int().min(10).max(120);
export const DiscoveryStepsSchema = z.number().int().min(2).max(20);
export const DiscoveryCapabilitySchema = z.object({ fixtureUrl: z.string().nullable() });
export const DiscoveryRolloutSchema = z.object({ available: z.boolean(), enabled: z.boolean() });

/** Exact fixture URL. Do not transmit query parameters, fragments or credentials to the launcher. */
export const DiscoveryFixtureUrlSchema = HttpUrlSchema
  .refine((value) => value.length <= 2048 && !/[?#]/.test(value), "Discovery requires a fixture URL of up to 2048 characters without a query or fragment")
  .transform((value) => new URL(value))
  .refine((url) => url.protocol === "http:" && Number(url.port) >= 1024, "Discovery requires an HTTP fixture on a port of 1024 or higher")
  .transform((url) => url.href);

export const DiscoveryInputSchema = z.strictObject({
  schemaVersion: version, runId, targetUrl: DiscoveryFixtureUrlSchema,
  timeoutSeconds: DiscoveryJobSecondsSchema.optional(),
  maxAgentSteps: DiscoveryStepsSchema.optional(),
});
export type DiscoveryInput = z.infer<typeof DiscoveryInputSchema>;

const candidateText = (min: number, max: number) =>
  z.string().trim().min(min).max(max).refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), "Use plain text");

export const DiscoveryFixturePathSchema = z.string().max(180).regex(
  /^\/(?:[a-zA-Z0-9_-][a-zA-Z0-9._~-]*(?:\/[a-zA-Z0-9_-][a-zA-Z0-9._~-]*)*\/?)?$/,
  "Expected a fixture path without a host, query, fragment or dot segments",
);

const DiscoveryCandidateSchema = z.strictObject({
  title: candidateText(3, 80),
  goal: candidateText(10, 500),
  rationale: candidateText(1, 300),
  relevantPaths: z.array(DiscoveryFixturePathSchema).min(1).max(8),
  expectedBehavior: z.array(candidateText(1, 180)).min(1).max(5),
  negativeCases: z.array(candidateText(1, 180)).max(5),
});

/** The egress proxy's refusal codes (proxy mode). */
export const DiscoveryEgressReasonSchema = z.enum([
  "not_allowlisted", "forbidden_address", "connect_denied", "bad_request", "unresolvable", "upstream_error",
]);

/** What the Python broker reports. */
export const DiscoveryStatusSchema = z.enum(["COMPLETED", "PARTIAL", "BLOCKED", "FAILED", "CANCELLED"]);
/** Why a broker job ended. Codes only; never page text or provider messages. */
export const DiscoveryResultReasonSchema = z.enum([
  "ok", "no_valid_candidates", "timeout", "max_steps", "hard_deadline", "cancelled", "agent_error", "no_result",
  "target_not_allowed", "model_not_configured", "docker_unavailable", "invalid_request",
]);
/**
 * A run's discovery outcome, as its events, metrics and report record it. TIMED_OUT and BUSY are platform
 * classifications: a time budget ran out, or the broker / tenant quota had no capacity. Neither is a failure of
 * Browser Use itself, and BUSY and BLOCKED outcomes never started an agent.
 */
export const DiscoveryOutcomeStatusSchema = z.enum(["COMPLETED", "PARTIAL", "TIMED_OUT", "BUSY", "BLOCKED", "FAILED", "CANCELLED"]);
export type DiscoveryOutcomeStatus = z.infer<typeof DiscoveryOutcomeStatusSchema>;
export const DiscoveryOutcomeReasonSchema = z.enum([
  ...DiscoveryResultReasonSchema.options,
  // Decided by the platform before or around the broker job.
  "not_configured", "fixture_mismatch", "environment", "tenant_disabled", "tenant_quota", "broker_busy", "capacity_wait", "no_budget",
  "worker_deadline", "broker_unavailable", "invalid_result",
]);
export type DiscoveryOutcomeReason = z.infer<typeof DiscoveryOutcomeReasonSchema>;
export const DiscoveryStatisticsSchema = z.strictObject({
  agentSteps: z.number().int().min(0).max(20),
  modelRequests: z.number().int().min(0).max(20),
  durationMs: z.number().int().min(0).max(240_000),
  inputTokens: z.number().int().min(0).max(100_000_000),
  outputTokens: z.number().int().min(0).max(1_000_000),
  modelCostUsd: z.number().min(0).nullable(),
  protocolViolations: z.number().int().min(0).max(1000).optional(),
  /** Peak memory of the job's agent container, sampled by the host launcher; null when no sample succeeded. */
  peakMemoryBytes: z.number().int().min(0).max(8 * 1024 ** 3).nullable().optional(),
  /** Proxy mode only: requests the job's egress proxy refused, in total and by reason code. Null in bundled mode. */
  blockedDestinations: z.number().int().min(0).max(100_000).nullable().optional(),
  blockedByReason: z.partialRecord(DiscoveryEgressReasonSchema, z.number().int().min(0).max(100_000)).nullable().optional(),
});
export const DiscoverySummarySchema = z.strictObject({
  status: DiscoveryOutcomeStatusSchema,
  /** Absent on summaries recorded before reasons existed. */
  reason: DiscoveryOutcomeReasonSchema.optional(),
  /** False: no broker job ran (configuration, rollout, quota, capacity or budget). Absent on older summaries. */
  attempted: z.boolean().optional(),
  candidateCount: z.number().int().min(0).max(12),
  acceptedCount: z.number().int().min(0).max(8),
  pageCount: z.number().int().min(0).max(96),
  fallbackUsed: z.boolean(),
  statistics: DiscoveryStatisticsSchema.optional(),
});
export type DiscoverySummary = z.infer<typeof DiscoverySummarySchema>;
export const DiscoveryProgressSchema = z.strictObject({ agentSteps: z.number().int().min(1).max(20) });
const responseFields = {
  schemaVersion: version, runId, reason: DiscoveryResultReasonSchema.optional(), statistics: DiscoveryStatisticsSchema.optional(),
};
export const DiscoveryResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ ...responseFields, status: z.literal("COMPLETED"), candidates: z.array(DiscoveryCandidateSchema).min(1).max(12) }),
  z.strictObject({
    ...responseFields,
    status: z.enum(["PARTIAL", "BLOCKED", "FAILED", "CANCELLED"]),
    candidates: z.tuple([]),
  }),
]);
export type DiscoveryResult = z.infer<typeof DiscoveryResultSchema>;
export type DiscoveryCandidate = z.infer<typeof DiscoveryCandidateSchema>;
