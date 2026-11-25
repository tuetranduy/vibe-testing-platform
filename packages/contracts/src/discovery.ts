import { z } from "zod";
import { HttpUrlSchema } from "./common";

const version = z.literal("discovery.v1");
const runId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
export const DEFAULT_DISCOVERY_SECONDS = 240;
export const MAX_DISCOVERY_SECONDS = 360;
export const MAX_DISCOVERY_AGENTS = 3;
// The broker can still be cleaning up after its job deadline.
const MAX_DISCOVERY_DURATION_MS = (MAX_DISCOVERY_SECONDS + 60) * 1000;

export const DiscoverySecondsSchema = z.number().int().min(15).max(MAX_DISCOVERY_SECONDS);
/** A broker job's whole wall-clock budget: container start, the agent and result delivery. */
export const DiscoveryJobSecondsSchema = z.number().int().min(10).max(MAX_DISCOVERY_SECONDS);
/** Accepted for old clients and stored runs. Discovery is bounded by elapsed time. */
export const DiscoveryStepsSchema = z.number().int().min(2);
export const DiscoveryCapabilitySchema = z.object({
  fixtureUrl: z.string().nullable(), verifiedSites: z.boolean().optional(),
  /** Live sites: the agent can interact with the site and submit forms with test data. */
  liveInteraction: z.boolean().optional(),
});
export const DiscoveryRolloutSchema = z.object({ available: z.boolean(), enabled: z.boolean() });

export const DiscoveryFixturePathSchema = z.string().max(180).regex(
  /^\/(?:[a-zA-Z0-9_-][a-zA-Z0-9._~-]*(?:\/[a-zA-Z0-9_-][a-zA-Z0-9._~-]*)*\/?)?$/,
  "Expected a fixture path without a host, query, fragment or dot segments",
);

/** A public HTTPS page on the default port; live-site discovery reads only this exact origin. */
export const DiscoveryLiveUrlSchema = HttpUrlSchema
  .refine((value) => value.length <= 2048 && !/[?#]/.test(value), "Use an HTTPS page URL without a query or fragment")
  .transform((value) => new URL(value))
  .refine((url) => url.protocol === "https:" && !url.port &&
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(url.hostname) &&
    url.hostname.length <= 220, "Use an HTTPS domain on the default port")
  .refine((url) => DiscoveryFixturePathSchema.safeParse(url.pathname).success, "Use a supported page path");

/** Exact fixture URL. Do not transmit query parameters, fragments or credentials to the launcher. */
export const DiscoveryFixtureUrlSchema = HttpUrlSchema
  .refine((value) => value.length <= 2048 && !/[?#]/.test(value), "Discovery requires a fixture URL of up to 2048 characters without a query or fragment")
  .transform((value) => new URL(value))
  .refine((url) => url.protocol === "http:" && Number(url.port) >= 1024, "Discovery requires an HTTP fixture on a port of 1024 or higher")
  .transform((url) => url.href);

/**
 * The run's own model and its key from Settings (the key Stagehand uses), for this job's broker only. The broker
 * keeps it in memory for the job and never passes it into the agent container; nothing persists or logs it.
 */
export const DiscoveryModelSchema = z.strictObject({
  provider: z.enum(["anthropic", "gemini", "deepseek"]),
  model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/),
  apiKey: z.string().min(8).max(512),
});
export type DiscoveryModel = z.infer<typeof DiscoveryModelSchema>;

export const DiscoveryInputSchema = z.strictObject({
  schemaVersion: version, runId,
  /** The fixture; or, with `live`, a public HTTPS page reached only through the job's inspecting egress proxy. */
  targetUrl: z.union([DiscoveryFixtureUrlSchema, DiscoveryLiveUrlSchema.transform((url) => url.href)]),
  live: z.literal(true).optional(),
  /** The run's model (Settings). Absent: the broker's own DISCOVERY_MODEL. */
  model: DiscoveryModelSchema.optional(),
  timeoutSeconds: DiscoveryJobSecondsSchema.optional(),
  maxAgentSteps: DiscoveryStepsSchema.optional(),
  snapshot: z.array(z.object({
    path: DiscoveryFixturePathSchema,
    title: z.string().max(150),
    evidence: z.string().max(550),
  }).strict()).min(1).max(6).optional(),
  /**
   * Phase B: the run's requirement (redacted, credential placeholders only), so the agent looks for routes that
   * exercise it. Untrusted text to the agent, like the pages it reads.
   */
  focus: z.string().trim().min(10).max(1000).refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), "Use plain text").optional(),
}).superRefine((input, ctx) => {
  if (Boolean(input.live) !== input.targetUrl.startsWith("https://")) {
    ctx.addIssue({ code: "custom", path: ["live"], message: "A live request names an HTTPS page; a fixture request the fixture" });
  }
  if (input.live && input.snapshot) ctx.addIssue({ code: "custom", path: ["snapshot"], message: "A live request reads the site itself" });
});
export type DiscoveryInput = z.infer<typeof DiscoveryInputSchema>;

const candidateText = (min: number, max: number) =>
  z.string().trim().min(min).max(max).refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), "Use plain text");

const DiscoveryCandidateSchema = z.strictObject({
  title: candidateText(3, 80),
  goal: candidateText(10, 500),
  rationale: candidateText(1, 300),
  relevantPaths: z.array(DiscoveryFixturePathSchema).min(1).max(8),
  expectedBehavior: z.array(candidateText(1, 180)).min(1).max(5),
  negativeCases: z.array(candidateText(1, 180)).max(5),
});

export const MAX_DISCOVERY_FINDINGS = 5;
/**
 * Phase C: something the agent saw that looks wrong (a broken link, a missing result, an error message). A
 * hypothesis only: it never becomes a failure without an independent reproduction or a person's review.
 */
const DiscoveryFindingCandidateSchema = z.strictObject({
  title: candidateText(3, 80),
  /** What the agent saw, in its own words. */
  observation: candidateText(10, 300),
  /** What a user would expect instead. */
  expected: candidateText(3, 180),
  path: DiscoveryFixturePathSchema,
  /** Plain-language steps to see it again: a proposal for the platform's own reproduction, never code. */
  reproduction: z.array(candidateText(1, 180)).min(1).max(6),
  severity: z.enum(["low", "medium", "high"]),
});
export type DiscoveryFindingCandidate = z.infer<typeof DiscoveryFindingCandidateSchema>;

/** The egress proxy's refusal codes (proxy mode). */
export const DiscoveryEgressReasonSchema = z.enum([
  "not_allowlisted", "forbidden_address", "connect_denied", "bad_request", "unresolvable", "upstream_error",
  // Live interaction: unsupported methods, protocol upgrades, failed interception and the rate limit.
  "method_denied", "upgrade_denied", "tls_error", "rate_limited",
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
  // A multi-agent run adds the agents' steps and model calls together.
  agentSteps: z.number().int().nonnegative(),
  modelRequests: z.number().int().nonnegative(),
  durationMs: z.number().int().min(0).max(MAX_DISCOVERY_DURATION_MS),
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
  candidateCount: z.number().int().min(0).max(36),
  acceptedCount: z.number().int().min(0).max(8),
  /** Phase C: the unverified findings stored for review. Absent: none were reported or stored. */
  findingCount: z.number().int().min(0).max(MAX_DISCOVERY_FINDINGS).optional(),
  /** Phase C: how many agents explored in parallel; absent: one. */
  agents: z.number().int().min(2).max(MAX_DISCOVERY_AGENTS).optional(),
  pageCount: z.number().int().min(0).max(96),
  fallbackUsed: z.boolean(),
  statistics: DiscoveryStatisticsSchema.optional(),
});
export type DiscoverySummary = z.infer<typeof DiscoverySummarySchema>;
export const DiscoveryProgressSchema = z.strictObject({ agentSteps: z.number().int().positive() });
const responseFields = {
  schemaVersion: version, runId, reason: DiscoveryResultReasonSchema.optional(), statistics: DiscoveryStatisticsSchema.optional(),
};
export const DiscoveryResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ ...responseFields, status: z.literal("COMPLETED"), candidates: z.array(DiscoveryCandidateSchema).min(1).max(12),
    findings: z.array(DiscoveryFindingCandidateSchema).max(MAX_DISCOVERY_FINDINGS).optional(),
  }),
  z.strictObject({
    ...responseFields,
    status: z.enum(["PARTIAL", "BLOCKED", "FAILED", "CANCELLED"]),
    candidates: z.tuple([]),
  }),
]);
export type DiscoveryResult = z.infer<typeof DiscoveryResultSchema>;
export type DiscoveryCandidate = z.infer<typeof DiscoveryCandidateSchema>;

/**
 * Phase B: a route Browser Use observed that bears on an explicit requirement. Context for the requirement
 * analysis and the planner, never a criterion by itself: a check it suggests is an inferred, non-critical criterion
 * that the person confirming the criteria reviews.
 */
export const DiscoveryRouteSchema = z.strictObject({
  title: candidateText(3, 80),
  goal: candidateText(10, 500),
  relevantPaths: z.array(DiscoveryFixturePathSchema).min(1).max(8),
  expectedBehavior: z.array(candidateText(1, 180)).min(1).max(3),
});
export type DiscoveryRoute = z.infer<typeof DiscoveryRouteSchema>;
export const MAX_DISCOVERY_ROUTES = 4;
/** What the analysis keeps of a requirement run's discovery: its outcome and the routes it handed on. */
export const RequirementDiscoverySchema = z.strictObject({
  summary: DiscoverySummarySchema,
  routes: z.array(DiscoveryRouteSchema).max(MAX_DISCOVERY_ROUTES),
});
export type RequirementDiscovery = z.infer<typeof RequirementDiscoverySchema>;
