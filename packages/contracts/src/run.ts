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

export const RunOptionsSchema = z.object({
  maxExplorationSteps: z.number().int().min(1).max(100).default(40),
  maxRunSeconds: z.number().int().min(60).max(1800).default(300),
  generatePlaywright: z.boolean().default(true),
  rerunGeneratedTest: z.boolean().default(true),
  autoConfirmCriteria: z.boolean().default(false),
  allowDestructiveActions: z.boolean().default(false),
  additionalAllowedHosts: z.array(HostnameSchema).max(10).default([]),
});
export type RunOptions = z.infer<typeof RunOptionsSchema>;

export const CreateTestRunRequestSchema = z
  .object({
    targetUrl: HttpUrlSchema,
    requirement: z.string().trim().min(10).max(20_000),
    environment: z.enum(["staging", "production"]).default("staging"),
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
  .refine((r) => !(r.environment === "production" && r.options.allowDestructiveActions), {
    message: "Destructive actions are never allowed in production",
    path: ["options", "allowDestructiveActions"],
  })
  .refine((r) => r.options.generatePlaywright || !r.options.rerunGeneratedTest, {
    message: "rerunGeneratedTest requires generatePlaywright",
    path: ["options", "rerunGeneratedTest"],
  });
export type CreateTestRunRequestInput = z.input<typeof CreateTestRunRequestSchema>;
export type CreateTestRunRequest = z.output<typeof CreateTestRunRequestSchema>;
/** The request as persisted: never contains secret values, only their names. */
export type StoredTestRunRequest = Omit<CreateTestRunRequest, "secrets"> & { secretNames: string[] };

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
