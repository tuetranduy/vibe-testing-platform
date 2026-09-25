CREATE TYPE "public"."artifact_sensitivity" AS ENUM('STANDARD', 'SECRET_BEARING');--> statement-breakpoint
CREATE TYPE "public"."artifact_type" AS ENUM('SCREENSHOT', 'TRACE', 'VIDEO', 'GENERATED_TEST', 'PLAYWRIGHT_REPORT');--> statement-breakpoint
CREATE TYPE "public"."cancel_reason" AS ENUM('USER_REQUESTED', 'CONFIRMATION_EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."criterion_status" AS ENUM('PASS', 'FAIL', 'BLOCKED', 'INCONCLUSIVE');--> statement-breakpoint
CREATE TYPE "public"."error_category" AS ENUM('MODEL_PROVIDER', 'BROWSER_PROVIDER', 'TIMEOUT', 'STORAGE', 'CONTRACT', 'WORKER_LOST', 'INTERNAL');--> statement-breakpoint
CREATE TYPE "public"."run_lifecycle" AS ENUM('QUEUED', 'ANALYZING_REQUIREMENT', 'AWAITING_CONFIRMATION', 'PLANNING', 'EXPLORING', 'VERIFYING', 'GENERATING_TEST', 'RUNNING_PLAYWRIGHT', 'GENERATING_REPORT', 'COMPLETED', 'ERRORED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."run_verdict" AS ENUM('PASSED', 'FAILED', 'BLOCKED', 'INCONCLUSIVE');--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"run_id" text NOT NULL,
	"type" "artifact_type" NOT NULL,
	"object_key" text NOT NULL,
	"sha256" text NOT NULL,
	"bytes" bigint NOT NULL,
	"content_type" text NOT NULL,
	"sensitivity" "artifact_sensitivity" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifacts_object_key_unique" UNIQUE("object_key")
);
--> statement-breakpoint
CREATE TABLE "criterion_results" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"criterion_id" text NOT NULL,
	"status" "criterion_status" NOT NULL,
	"json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "diagnostic_findings" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"criterion_id" text,
	"summary" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exploration_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"index" integer NOT NULL,
	"json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "generated_tests" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"source" text NOT NULL,
	"helpers_source" text NOT NULL,
	"data_json" text NOT NULL,
	"compiled_criteria" jsonb NOT NULL,
	"not_compiled" jsonb NOT NULL,
	"notes" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "generated_tests_run_id_unique" UNIQUE("run_id")
);
--> statement-breakpoint
CREATE TABLE "llm_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"stage" "run_lifecycle" NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"estimated_cost_usd" double precision NOT NULL,
	"latency_ms" integer NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "observed_facts" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"key" text NOT NULL,
	"checkpoint" text NOT NULL,
	"json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "requirement_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"revision" integer NOT NULL,
	"json" jsonb NOT NULL,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_secrets" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"name" text NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"iv" "bytea" NOT NULL,
	"auth_tag" "bytea" NOT NULL,
	"purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "test_events" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"type" text NOT NULL,
	"stage" "run_lifecycle" NOT NULL,
	"message" text NOT NULL,
	"payload" jsonb NOT NULL,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "test_plans" (
	"run_id" text PRIMARY KEY NOT NULL,
	"json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "test_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"target_url" text NOT NULL,
	"request_json" jsonb NOT NULL,
	"lifecycle" "run_lifecycle" DEFAULT 'QUEUED' NOT NULL,
	"lifecycle_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verdict" "run_verdict",
	"error_category" "error_category",
	"error_message" text,
	"cancel_requested_at" timestamp with time zone,
	"cancel_reason" "cancel_reason",
	"heartbeat_at" timestamp with time zone,
	"deadline_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"next_event_sequence" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text,
	"request_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "test_runs_verdict_iff_completed" CHECK (("test_runs"."verdict" IS NOT NULL) = ("test_runs"."lifecycle" = 'COMPLETED')),
	CONSTRAINT "test_runs_error_iff_errored" CHECK (("test_runs"."error_category" IS NOT NULL) = ("test_runs"."lifecycle" = 'ERRORED'))
);
--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_run_id_test_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."test_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "criterion_results" ADD CONSTRAINT "criterion_results_run_id_test_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."test_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagnostic_findings" ADD CONSTRAINT "diagnostic_findings_run_id_test_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."test_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exploration_steps" ADD CONSTRAINT "exploration_steps_run_id_test_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."test_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generated_tests" ADD CONSTRAINT "generated_tests_run_id_test_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."test_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_run_id_test_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."test_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observed_facts" ADD CONSTRAINT "observed_facts_run_id_test_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."test_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_revisions" ADD CONSTRAINT "requirement_revisions_run_id_test_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."test_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_secrets" ADD CONSTRAINT "run_secrets_run_id_test_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."test_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_events" ADD CONSTRAINT "test_events_run_id_test_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."test_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_plans" ADD CONSTRAINT "test_plans_run_id_test_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."test_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifacts_run" ON "artifacts" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "artifacts_expires" ON "artifacts" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "criterion_results_run_criterion" ON "criterion_results" USING btree ("run_id","criterion_id");--> statement-breakpoint
CREATE UNIQUE INDEX "exploration_steps_run_index" ON "exploration_steps" USING btree ("run_id","index");--> statement-breakpoint
CREATE INDEX "llm_calls_run" ON "llm_calls" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "observed_facts_run_key_checkpoint" ON "observed_facts" USING btree ("run_id","key","checkpoint");--> statement-breakpoint
CREATE UNIQUE INDEX "requirement_revisions_run_revision" ON "requirement_revisions" USING btree ("run_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "run_secrets_run_name" ON "run_secrets" USING btree ("run_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "test_events_run_sequence" ON "test_events" USING btree ("run_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "test_runs_tenant_idempotency_key" ON "test_runs" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "test_runs_tenant_created" ON "test_runs" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "test_runs_lifecycle_heartbeat" ON "test_runs" USING btree ("lifecycle","heartbeat_at");