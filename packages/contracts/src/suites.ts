import { z } from "zod";
import { IsoDateTime } from "./common";
import {
  EnvironmentSchema,
  RunLifecycleSchema,
  RunVerdictSchema,
  SavedIdSchema,
  SavedRefSchema,
  SecretRecordSchema,
  isTerminalLifecycle,
  type RunLifecycle,
  type RunVerdict,
} from "./run";
import { RunChangeSchema } from "./comparison";
import { RunOwnerSchema } from "./users";

/**
 * Suites (V1.2 F1): a named list of saved Playwright tests (each pinned to the finished run that generated it)
 * that run together, with no model call. A suite run reruns every entry as its own run and settles once they
 * have all finished.
 */
export const MAX_SUITE_ENTRIES = 50;

const NameSchema = z.string().trim().min(1, "Enter a name").max(100);
const DescriptionSchema = z.string().trim().max(500);

export const SuiteInputSchema = z.object({
  name: NameSchema,
  description: DescriptionSchema.default(""),
  /** Saved credentials that fill the suite's secrets when a run doesn't give them (and always for a schedule). */
  credentialProfileId: SavedIdSchema.nullable().default(null),
});
export type SuiteInput = z.input<typeof SuiteInputSchema>;

export const AddSuiteEntryRequestSchema = z.object({
  sourceRunId: SavedIdSchema,
  /**
   * Required (true) when the run allowed destructive actions: every run of the suite repeats them without asking
   * again (the same confirmation a manual rerun needs, given once).
   */
  confirmDestructiveActions: z.boolean().optional(),
});
export type AddSuiteEntryRequest = z.input<typeof AddSuiteEntryRequestSchema>;

export const ReorderSuiteEntriesRequestSchema = z.object({
  sourceRunIds: z.array(SavedIdSchema).max(MAX_SUITE_ENTRIES),
});
export type ReorderSuiteEntriesRequest = z.infer<typeof ReorderSuiteEntriesRequestSchema>;

export const RunSuiteRequestSchema = z.object({
  /** Secrets for this run only; they win over the credentials below. */
  secrets: SecretRecordSchema.default({}),
  /** Saved credentials for this run; they win over the suite's own. */
  credentialProfileId: SavedIdSchema.optional(),
});
export type RunSuiteRequestInput = z.input<typeof RunSuiteRequestSchema>;

export const SuiteRunTriggerSchema = z.enum(["manual", "schedule", "api"]);
export type SuiteRunTrigger = z.infer<typeof SuiteRunTriggerSchema>;
export const SuiteRunStatusSchema = z.enum(["RUNNING", "COMPLETED"]);
export type SuiteRunStatus = z.infer<typeof SuiteRunStatusSchema>;

/** A child's result, as the suite run shows it. */
const ChildResultSchema = z.object({
  runId: z.string(),
  lifecycle: RunLifecycleSchema,
  verdict: RunVerdictSchema.nullable(),
  finishedAt: IsoDateTime.nullable(),
});

export const SuiteEntryViewSchema = z.object({
  sourceRunId: z.string(),
  position: z.number().int(),
  /** The source's requirement, shortened. */
  title: z.string(),
  targetUrl: z.string(),
  environment: EnvironmentSchema,
  secretNames: z.array(z.string()),
  /** The run allowed destructive actions and the suite repeats them. */
  destructive: z.boolean(),
  compiledCriteria: z.number().int(),
  /** This test's latest result in a run of this suite. */
  lastResult: ChildResultSchema.nullable(),
  addedAt: IsoDateTime,
});
export type SuiteEntryView = z.infer<typeof SuiteEntryViewSchema>;

export const SuiteRunBriefSchema = z.object({
  id: z.string(),
  trigger: SuiteRunTriggerSchema,
  status: SuiteRunStatusSchema,
  verdict: RunVerdictSchema.nullable(),
  createdAt: IsoDateTime,
  finishedAt: IsoDateTime.nullable(),
});
export type SuiteRunBrief = z.infer<typeof SuiteRunBriefSchema>;

export const SuiteViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  credentialProfile: SavedRefSchema.nullable(),
  owner: RunOwnerSchema.nullable(),
  entryCount: z.number().int(),
  /** Every secret name the entries use. */
  secretNames: z.array(z.string()),
  /** The ones the suite's saved credentials don't provide: a run must give them. */
  missingSecretNames: z.array(z.string()),
  lastRun: SuiteRunBriefSchema.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type SuiteView = z.infer<typeof SuiteViewSchema>;

export const SuiteDetailSchema = SuiteViewSchema.extend({ entries: z.array(SuiteEntryViewSchema) });
export type SuiteDetail = z.infer<typeof SuiteDetailSchema>;

export const SuiteListSchema = z.object({ items: z.array(SuiteViewSchema) });
export type SuiteList = z.infer<typeof SuiteListSchema>;

export const SuiteRunChildSchema = ChildResultSchema.extend({
  sourceRunId: z.string(),
  title: z.string(),
  targetUrl: z.string(),
  /** Against this test's previous finished run (V1.2 F2); null while the child is running. */
  change: RunChangeSchema.nullable().default(null),
  /** The run it was compared with. */
  baselineRunId: z.string().nullable().default(null),
});
export type SuiteRunChild = z.infer<typeof SuiteRunChildSchema>;

export const SuiteRunCountsSchema = z.object({
  total: z.number().int(),
  active: z.number().int(),
  passed: z.number().int(),
  failed: z.number().int(),
  blocked: z.number().int(),
  inconclusive: z.number().int(),
  /** Errored or cancelled: no verdict. */
  noVerdict: z.number().int(),
});
export type SuiteRunCounts = z.infer<typeof SuiteRunCountsSchema>;

export const SuiteRunViewSchema = SuiteRunBriefSchema.extend({
  suiteId: z.string(),
  suiteName: z.string(),
  owner: RunOwnerSchema.nullable(),
  counts: SuiteRunCountsSchema,
  /** Children that got worse / better than their previous run (V1.2 F2). */
  changes: z.object({ regressed: z.number().int(), fixed: z.number().int() }).default({ regressed: 0, fixed: 0 }),
  children: z.array(SuiteRunChildSchema),
});
export type SuiteRunView = z.infer<typeof SuiteRunViewSchema>;

export const SuiteRunListSchema = z.object({ items: z.array(SuiteRunBriefSchema) });
export type SuiteRunList = z.infer<typeof SuiteRunListSchema>;

export const RunSuiteResponseSchema = z.object({ suiteRunId: z.string(), runIds: z.array(z.string()) });
export type RunSuiteResponse = z.infer<typeof RunSuiteResponseSchema>;

/**
 * A settled suite run's verdict (every child terminal): FAILED if any child failed, else BLOCKED if any was
 * blocked, else INCONCLUSIVE if any was inconclusive or ended without a verdict (errored, cancelled), else PASSED.
 * Null while a child is still running.
 */
export function suiteVerdict(children: readonly { lifecycle: RunLifecycle; verdict: RunVerdict | null }[]): RunVerdict | null {
  if (children.some((c) => !isTerminalLifecycle(c.lifecycle))) return null;
  if (children.some((c) => c.verdict === "FAILED")) return "FAILED";
  if (children.some((c) => c.verdict === "BLOCKED")) return "BLOCKED";
  if (children.some((c) => c.verdict !== "PASSED")) return "INCONCLUSIVE";
  return "PASSED";
}

export function suiteRunCounts(children: readonly { lifecycle: RunLifecycle; verdict: RunVerdict | null }[]): SuiteRunCounts {
  const counts: SuiteRunCounts = { total: children.length, active: 0, passed: 0, failed: 0, blocked: 0, inconclusive: 0, noVerdict: 0 };
  for (const c of children) {
    if (!isTerminalLifecycle(c.lifecycle)) counts.active += 1;
    else if (c.verdict === "PASSED") counts.passed += 1;
    else if (c.verdict === "FAILED") counts.failed += 1;
    else if (c.verdict === "BLOCKED") counts.blocked += 1;
    else if (c.verdict === "INCONCLUSIVE") counts.inconclusive += 1;
    else counts.noVerdict += 1;
  }
  return counts;
}

/**
 * Schedules (V1.2 F3): a suite run at the times a five-field cron expression names, in a time zone. A scheduled
 * run can only use the suite's saved credentials, so a schedule is refused while they don't cover every secret.
 */
export const MAX_SCHEDULES_PER_SUITE = 5;
export const MAX_SCHEDULES_PER_TENANT = 50;

/** Five fields (minute hour day-of-month month day-of-week): no seconds field. */
export const CronSchema = z
  .string()
  .trim()
  .max(100)
  .refine((v) => v.split(/\s+/).length === 5, "Use five fields: minute hour day-of-month month day-of-week");

export const TimeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, "Unknown time zone");

export const ScheduleInputSchema = z.object({
  cron: CronSchema,
  timezone: TimeZoneSchema.default("UTC"),
  enabled: z.boolean().default(true),
});
export type ScheduleInput = z.input<typeof ScheduleInputSchema>;

/** What happened the last time a schedule fired. */
export const ScheduleOutcomeSchema = z.enum(["started", "skipped_running", "failed"]);
export type ScheduleOutcome = z.infer<typeof ScheduleOutcomeSchema>;

export const ScheduleViewSchema = z.object({
  id: z.string(),
  suiteId: z.string(),
  cron: z.string(),
  timezone: z.string(),
  enabled: z.boolean(),
  /** Null while disabled. */
  nextRunAt: IsoDateTime.nullable(),
  lastFiredAt: IsoDateTime.nullable(),
  lastOutcome: ScheduleOutcomeSchema.nullable(),
  /** Why the last firing failed (an API error code). */
  lastError: z.string().nullable(),
  lastSuiteRunId: z.string().nullable(),
  createdBy: RunOwnerSchema.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ScheduleView = z.infer<typeof ScheduleViewSchema>;

export const ScheduleListSchema = z.object({ items: z.array(ScheduleViewSchema) });
