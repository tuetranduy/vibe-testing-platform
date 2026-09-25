import {
  ArtifactSensitivitySchema,
  ArtifactTypeSchema,
  CancelReasonSchema,
  CriterionStatusSchema,
  ErrorCategorySchema,
  RunLifecycleSchema,
  RunVerdictSchema,
} from "@platform/contracts";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Enum values come straight from the contracts so the two lists can't drift.
const values = <T extends string>(o: readonly T[]) => o as unknown as [T, ...T[]];
export const runLifecycleEnum = pgEnum("run_lifecycle", values(RunLifecycleSchema.options));
export const runVerdictEnum = pgEnum("run_verdict", values(RunVerdictSchema.options));
export const errorCategoryEnum = pgEnum("error_category", values(ErrorCategorySchema.options));
export const cancelReasonEnum = pgEnum("cancel_reason", values(CancelReasonSchema.options));
export const criterionStatusEnum = pgEnum("criterion_status", values(CriterionStatusSchema.options));
export const artifactTypeEnum = pgEnum("artifact_type", values(ArtifactTypeSchema.options));
export const artifactSensitivityEnum = pgEnum("artifact_sensitivity", values(ArtifactSensitivitySchema.options));

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();

export const tenants = pgTable("tenants", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: createdAt(),
});

export const testRuns = pgTable(
  "test_runs",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    targetUrl: text("target_url").notNull(),
    /** The create request WITHOUT secret values (StoredTestRunRequest). */
    requestJson: jsonb("request_json").notNull(),
    lifecycle: runLifecycleEnum("lifecycle").notNull().default("QUEUED"),
    lifecycleChangedAt: ts("lifecycle_changed_at").notNull().defaultNow(),
    verdict: runVerdictEnum("verdict"),
    errorCategory: errorCategoryEnum("error_category"),
    errorMessage: text("error_message"),
    cancelRequestedAt: ts("cancel_requested_at"),
    cancelReason: cancelReasonEnum("cancel_reason"),
    heartbeatAt: ts("heartbeat_at"),
    deadlineAt: ts("deadline_at"),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
    nextEventSequence: integer("next_event_sequence").notNull().default(0),
    idempotencyKey: text("idempotency_key"),
    requestHash: text("request_hash"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("test_runs_tenant_idempotency_key").on(t.tenantId, t.idempotencyKey),
    index("test_runs_tenant_created").on(t.tenantId, t.createdAt),
    index("test_runs_lifecycle_heartbeat").on(t.lifecycle, t.heartbeatAt),
    // Section 2.1 invariants, enforced by the database as well as the repository.
    check("test_runs_verdict_iff_completed", sql`(${t.verdict} IS NOT NULL) = (${t.lifecycle} = 'COMPLETED')`),
    check("test_runs_error_iff_errored", sql`(${t.errorCategory} IS NOT NULL) = (${t.lifecycle} = 'ERRORED')`),
  ],
);

export const runSecrets = pgTable(
  "run_secrets",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => testRuns.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    ciphertext: bytea("ciphertext").notNull(),
    iv: bytea("iv").notNull(),
    authTag: bytea("auth_tag").notNull(),
    purgedAt: ts("purged_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("run_secrets_run_name").on(t.runId, t.name)],
);

export const requirementRevisions = pgTable(
  "requirement_revisions",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => testRuns.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    json: jsonb("json").notNull(),
    confirmedAt: ts("confirmed_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("requirement_revisions_run_revision").on(t.runId, t.revision)],
);

export const testPlans = pgTable("test_plans", {
  runId: text("run_id")
    .primaryKey()
    .references(() => testRuns.id, { onDelete: "cascade" }),
  json: jsonb("json").notNull(),
  createdAt: createdAt(),
});

export const explorationSteps = pgTable(
  "exploration_steps",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => testRuns.id, { onDelete: "cascade" }),
    index: integer("index").notNull(),
    json: jsonb("json").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("exploration_steps_run_index").on(t.runId, t.index)],
);

export const observedFacts = pgTable(
  "observed_facts",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => testRuns.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    checkpoint: text("checkpoint").notNull(),
    json: jsonb("json").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("observed_facts_run_key_checkpoint").on(t.runId, t.key, t.checkpoint)],
);

export const criterionResults = pgTable(
  "criterion_results",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => testRuns.id, { onDelete: "cascade" }),
    criterionId: text("criterion_id").notNull(),
    status: criterionStatusEnum("status").notNull(),
    json: jsonb("json").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("criterion_results_run_criterion").on(t.runId, t.criterionId)],
);

export const generatedTests = pgTable("generated_tests", {
  id: text("id").primaryKey(),
  runId: text("run_id")
    .notNull()
    .unique()
    .references(() => testRuns.id, { onDelete: "cascade" }),
  source: text("source").notNull(),
  helpersSource: text("helpers_source").notNull(),
  dataJson: text("data_json").notNull(),
  compiledCriteria: jsonb("compiled_criteria").notNull(),
  notCompiled: jsonb("not_compiled").notNull(),
  notes: jsonb("notes").notNull(),
  createdAt: createdAt(),
});

export const artifacts = pgTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    runId: text("run_id")
      .notNull()
      .references(() => testRuns.id, { onDelete: "cascade" }),
    type: artifactTypeEnum("type").notNull(),
    objectKey: text("object_key").notNull().unique(),
    sha256: text("sha256").notNull(),
    bytes: bigint("bytes", { mode: "number" }).notNull(),
    contentType: text("content_type").notNull(),
    sensitivity: artifactSensitivityEnum("sensitivity").notNull(),
    expiresAt: ts("expires_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("artifacts_run").on(t.runId), index("artifacts_expires").on(t.expiresAt)],
);

export const testEvents = pgTable(
  "test_events",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => testRuns.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    type: text("type").notNull(),
    stage: runLifecycleEnum("stage").notNull(),
    message: text("message").notNull(),
    payload: jsonb("payload").notNull(),
    timestamp: ts("timestamp").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("test_events_run_sequence").on(t.runId, t.sequence)],
);

export const diagnosticFindings = pgTable("diagnostic_findings", {
  id: text("id").primaryKey(),
  runId: text("run_id")
    .notNull()
    .references(() => testRuns.id, { onDelete: "cascade" }),
  criterionId: text("criterion_id"),
  summary: text("summary").notNull(),
  createdAt: createdAt(),
});

export const llmCalls = pgTable(
  "llm_calls",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => testRuns.id, { onDelete: "cascade" }),
    stage: runLifecycleEnum("stage").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    estimatedCostUsd: doublePrecision("estimated_cost_usd").notNull(),
    latencyMs: integer("latency_ms").notNull(),
    status: text("status").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("llm_calls_run").on(t.runId)],
);
