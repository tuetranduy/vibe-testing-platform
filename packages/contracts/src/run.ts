import { z } from "zod";
import { DataKeySchema, HostnameSchema, HttpUrlSchema, IsoDateTime, SecretNameSchema } from "./common";

export const RunLifecycleSchema = z.enum([
  "QUEUED",
  "ANALYZING_REQUIREMENT",
  "AWAITING_CONFIRMATION",
  "PLANNING",
  "EXPLORING",
  "VERIFYING",
  "GENERATING_TEST",
  "RUNNING_PLAYWRIGHT",
  "GENERATING_REPORT",
  "COMPLETED",
  "ERRORED",
  "CANCELLED",
]);
export type RunLifecycle = z.infer<typeof RunLifecycleSchema>;

export const TERMINAL_LIFECYCLES = ["COMPLETED", "ERRORED", "CANCELLED"] as const;
export type TerminalLifecycle = (typeof TERMINAL_LIFECYCLES)[number];
export const isTerminalLifecycle = (l: RunLifecycle): l is TerminalLifecycle =>
  (TERMINAL_LIFECYCLES as readonly string[]).includes(l);

export const RunVerdictSchema = z.enum(["PASSED", "FAILED", "BLOCKED", "INCONCLUSIVE"]);
export type RunVerdict = z.infer<typeof RunVerdictSchema>;

export const CriterionStatusSchema = z.enum(["PASS", "FAIL", "BLOCKED", "INCONCLUSIVE"]);
export type CriterionStatus = z.infer<typeof CriterionStatusSchema>;

export const ErrorCategorySchema = z.enum([
  "MODEL_PROVIDER",
  "BROWSER_PROVIDER",
  "TIMEOUT",
  "STORAGE",
  "CONTRACT",
  "WORKER_LOST",
  "INTERNAL",
]);
export type ErrorCategory = z.infer<typeof ErrorCategorySchema>;

export const CancelReasonSchema = z.enum(["USER_REQUESTED", "CONFIRMATION_EXPIRED"]);
export type CancelReason = z.infer<typeof CancelReasonSchema>;

export const BlockReasonSchema = z.enum([
  "MISSING_SECRET",
  "MISSING_TEST_DATA",
  "DESTRUCTIVE_ACTION_NOT_AUTHORIZED",
  "TARGET_BLOCKED_BY_POLICY",
  "OFF_DOMAIN_NAVIGATION",
  "LOGIN_FAILED",
  "PRECONDITION_NOT_MET",
]);
export type BlockReason = z.infer<typeof BlockReasonSchema>;

export const InconclusiveReasonSchema = z.enum([
  "STEP_LIMIT_REACHED",
  "EXPLORATION_BUDGET_EXHAUSTED",
  "FACT_NOT_OBSERVED",
  "UNVERIFIED_EVIDENCE",
  "DISCOVERY_RERUN_DISAGREE",
  "AI_JUDGED_ONLY",
  "AMBIGUOUS_CRITERION",
]);
export type InconclusiveReason = z.infer<typeof InconclusiveReasonSchema>;

export const TestDataValueSchema = z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]);
export type TestDataValue = z.infer<typeof TestDataValueSchema>;

export const EnvironmentSchema = z.enum(["staging", "production"]);
export type Environment = z.infer<typeof EnvironmentSchema>;

export const RunOptionsSchema = z
  .object({
    maxExplorationSteps: z.number().int().min(1).max(100).default(40),
    maxRunSeconds: z.number().int().min(60).max(1800).default(300),
    generatePlaywright: z.boolean().default(true),
    /** Omitted: off when destructive actions are allowed (the rerun repeats every action), on otherwise. */
    rerunGeneratedTest: z.boolean().optional(),
    autoConfirmCriteria: z.boolean().default(false),
    allowDestructiveActions: z.boolean().default(false),
    /** Production only: the target URL's host, typed as the confirmation that destructive actions may run there. */
    confirmProductionHost: z.string().trim().min(1).max(255).optional(),
    additionalAllowedHosts: z.array(HostnameSchema).max(10).default([]),
  })
  .transform(({ rerunGeneratedTest, ...options }) => ({
    ...options,
    rerunGeneratedTest: rerunGeneratedTest ?? !options.allowDestructiveActions,
  }));
export type RunOptions = z.infer<typeof RunOptionsSchema>;

export const CreateTestRunRequestSchema = z
  .object({
    targetUrl: HttpUrlSchema,
    requirement: z.string().trim().min(10).max(20_000),
    environment: EnvironmentSchema.default("staging"),
    browser: z.literal("chromium").default("chromium"),
    testData: z
      .record(DataKeySchema, TestDataValueSchema)
      .refine((o) => Object.keys(o).length <= 50, "At most 50 test data entries")
      .default({}),
    /** Write-only. Never returned, logged, or sent to a model. */
    secrets: z
      .record(SecretNameSchema, z.string().min(4).max(4096))
      .refine((o) => Object.keys(o).length <= 10, "At most 10 secrets")
      .default({}),
    // .prefault({}) — Zod 4 .default() short-circuits and would skip nested defaults.
    options: RunOptionsSchema.prefault({}),
  })
  .superRefine((r, ctx) => {
    // D9, amended 2026-09-28: production allows destructive actions only with the target host typed as confirmation.
    // Zod 4 runs this even when a field failed its own check (e.g. a string that is not a URL): an unparseable URL
    // is left to its own issue, never parsed here unguarded.
    const path = ["options", "confirmProductionHost"];
    if (r.environment === "production" && r.options.allowDestructiveActions) {
      const host = hostOf(r.targetUrl);
      if (host !== null && !hostConfirmed(r.targetUrl, r.options.confirmProductionHost)) {
        ctx.addIssue({ code: "custom", path, message: `Type the website's host (${host}) to allow destructive actions in production` });
      }
    } else if (r.options.confirmProductionHost !== undefined) {
      ctx.addIssue({ code: "custom", path, message: "Only used when destructive actions are allowed in production" });
    }
  })
  .refine((r) => r.options.generatePlaywright || !r.options.rerunGeneratedTest, {
    message: "rerunGeneratedTest requires generatePlaywright",
    path: ["options", "rerunGeneratedTest"],
  });
export type CreateTestRunRequestInput = z.input<typeof CreateTestRunRequestSchema>;
export type CreateTestRunRequest = z.output<typeof CreateTestRunRequestSchema>;
/** The request as persisted: never contains secret values, only their names. */
export type StoredTestRunRequest = Omit<CreateTestRunRequest, "secrets"> & { secretNames: string[] };

/**
 * D9, amended 2026-09-28: destructive actions are allowed only when the run sets `allowDestructiveActions` — and,
 * in production, also confirms the target host. The contract enforces the confirmation on create; the engine and
 * the run summary decide with this, so a stored request without it is still denied.
 */
export function destructiveActionsAllowed(request: Pick<StoredTestRunRequest, "targetUrl" | "environment" | "options">): boolean {
  if (!request.options.allowDestructiveActions) return false;
  return request.environment !== "production" || hostConfirmed(request.targetUrl, request.options.confirmProductionHost);
}

/** The URL's host as the confirmation names it (lowercase, a non-default port included), or null if it doesn't parse. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** `typed` names the target URL's host: case-insensitive, the port included when the URL has one. */
function hostConfirmed(targetUrl: string, typed: string | undefined): boolean {
  const host = hostOf(targetUrl);
  return host !== null && typed !== undefined && typed.trim().toLowerCase() === host;
}

export const TestRunSummarySchema = z.object({
  runId: z.string(),
  lifecycle: RunLifecycleSchema,
  verdict: RunVerdictSchema.nullable(),
  errorCategory: ErrorCategorySchema.nullable(),
  cancelReason: CancelReasonSchema.nullable(),
  targetUrl: z.string(),
  requirementPreview: z.string().max(200),
  createdAt: IsoDateTime,
  startedAt: IsoDateTime.nullable(),
  finishedAt: IsoDateTime.nullable(),
});
export type TestRunSummary = z.infer<typeof TestRunSummarySchema>;

export const TestRunListResponseSchema = z.object({
  items: z.array(TestRunSummarySchema),
  nextCursor: z.string().nullable(),
});
export type TestRunListResponse = z.infer<typeof TestRunListResponseSchema>;

export const CreateTestRunResponseSchema = z.object({
  runId: z.string(),
  lifecycle: z.literal("QUEUED"),
  eventsUrl: z.string(),
});
export type CreateTestRunResponse = z.infer<typeof CreateTestRunResponseSchema>;

export const ApiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  issues: z.array(z.object({ path: z.array(z.union([z.string(), z.number()])), message: z.string() })).optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
