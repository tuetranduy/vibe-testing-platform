CREATE TABLE "suite_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"suite_id" text NOT NULL,
	"cron" text NOT NULL,
	"timezone" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"last_fired_at" timestamp with time zone,
	"last_outcome" text,
	"last_error" text,
	"last_suite_run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "suite_schedules" ADD CONSTRAINT "suite_schedules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suite_schedules" ADD CONSTRAINT "suite_schedules_suite_id_test_suites_id_fk" FOREIGN KEY ("suite_id") REFERENCES "public"."test_suites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suite_schedules" ADD CONSTRAINT "suite_schedules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "suite_schedules_suite" ON "suite_schedules" USING btree ("suite_id");--> statement-breakpoint
CREATE INDEX "suite_schedules_tenant" ON "suite_schedules" USING btree ("tenant_id");