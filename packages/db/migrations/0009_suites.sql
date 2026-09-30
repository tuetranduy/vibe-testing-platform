CREATE TYPE "public"."suite_run_status" AS ENUM('RUNNING', 'COMPLETED');--> statement-breakpoint
CREATE TYPE "public"."suite_run_trigger" AS ENUM('manual', 'schedule', 'api');--> statement-breakpoint
CREATE TABLE "suite_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"suite_id" text NOT NULL,
	"suite_name" text NOT NULL,
	"trigger" "suite_run_trigger" NOT NULL,
	"schedule_id" text,
	"owner_user_id" text,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "suite_run_status" DEFAULT 'RUNNING' NOT NULL,
	"verdict" "run_verdict",
	"idempotency_key" text,
	"request_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "suite_runs_verdict_iff_completed" CHECK (("suite_runs"."verdict" IS NOT NULL) = ("suite_runs"."status" = 'COMPLETED'))
);
--> statement-breakpoint
CREATE TABLE "test_suite_entries" (
	"suite_id" text NOT NULL,
	"source_run_id" text NOT NULL,
	"position" integer NOT NULL,
	"confirm_destructive" boolean DEFAULT false NOT NULL,
	"added_by" text,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "test_suite_entries_suite_id_source_run_id_pk" PRIMARY KEY("suite_id","source_run_id")
);
--> statement-breakpoint
CREATE TABLE "test_suites" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"credential_profile_id" text,
	"owner_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "test_runs" ADD COLUMN "suite_run_id" text;--> statement-breakpoint
ALTER TABLE "suite_runs" ADD CONSTRAINT "suite_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suite_runs" ADD CONSTRAINT "suite_runs_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_suite_entries" ADD CONSTRAINT "test_suite_entries_suite_id_test_suites_id_fk" FOREIGN KEY ("suite_id") REFERENCES "public"."test_suites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_suite_entries" ADD CONSTRAINT "test_suite_entries_source_run_id_test_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."test_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_suite_entries" ADD CONSTRAINT "test_suite_entries_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_suites" ADD CONSTRAINT "test_suites_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_suites" ADD CONSTRAINT "test_suites_credential_profile_id_credential_profiles_id_fk" FOREIGN KEY ("credential_profile_id") REFERENCES "public"."credential_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_suites" ADD CONSTRAINT "test_suites_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "suite_runs_suite_created" ON "suite_runs" USING btree ("tenant_id","suite_id","created_at");--> statement-breakpoint
CREATE INDEX "suite_runs_status" ON "suite_runs" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "suite_runs_tenant_idempotency_key" ON "suite_runs" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "test_suites_tenant_name" ON "test_suites" USING btree ("tenant_id",lower("name"));--> statement-breakpoint
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_suite_run_id_suite_runs_id_fk" FOREIGN KEY ("suite_run_id") REFERENCES "public"."suite_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "test_runs_suite_run" ON "test_runs" USING btree ("suite_run_id");