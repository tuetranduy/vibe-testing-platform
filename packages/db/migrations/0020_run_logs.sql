CREATE TABLE "llm_call_exchanges" (
	"llm_call_id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"body" "bytea" NOT NULL,
	"bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"time" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"level" text NOT NULL,
	"stage" "run_lifecycle",
	"component" text NOT NULL,
	"message" text NOT NULL,
	"fields" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "llm_calls" ADD COLUMN "purpose" text;--> statement-breakpoint
ALTER TABLE "llm_call_exchanges" ADD CONSTRAINT "llm_call_exchanges_llm_call_id_llm_calls_id_fk" FOREIGN KEY ("llm_call_id") REFERENCES "public"."llm_calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_call_exchanges" ADD CONSTRAINT "llm_call_exchanges_run_id_test_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."test_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_call_exchanges" ADD CONSTRAINT "llm_call_exchanges_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_logs" ADD CONSTRAINT "run_logs_run_id_test_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."test_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_logs" ADD CONSTRAINT "run_logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "llm_call_exchanges_run" ON "llm_call_exchanges" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "llm_call_exchanges_created" ON "llm_call_exchanges" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "run_logs_run_time" ON "run_logs" USING btree ("run_id","time","id");--> statement-breakpoint
CREATE INDEX "run_logs_time" ON "run_logs" USING btree ("time");--> statement-breakpoint
-- KI-027 (D6): the run's tenant, filled from test_runs whatever the writer passes.
CREATE TRIGGER "run_logs_set_tenant_id" BEFORE INSERT ON "run_logs" FOR EACH ROW EXECUTE FUNCTION set_run_tenant_id();
--> statement-breakpoint
CREATE TRIGGER "llm_call_exchanges_set_tenant_id" BEFORE INSERT ON "llm_call_exchanges" FOR EACH ROW EXECUTE FUNCTION set_run_tenant_id();
--> statement-breakpoint
-- No policies on purpose (0017): closes Supabase's automatic API to the tables.
ALTER TABLE "run_logs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "llm_call_exchanges" ENABLE ROW LEVEL SECURITY;
