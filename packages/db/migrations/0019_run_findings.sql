CREATE TABLE "run_findings" (
	"run_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"finding_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_findings_run_id_finding_id_pk" PRIMARY KEY("run_id","finding_id")
);
--> statement-breakpoint
ALTER TABLE "run_findings" ADD CONSTRAINT "run_findings_run_id_test_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."test_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_findings" ADD CONSTRAINT "run_findings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_findings_tenant_fingerprint_idx" ON "run_findings" USING btree ("tenant_id","fingerprint");--> statement-breakpoint
-- KI-027 (D6): the run's tenant, filled from test_runs whatever the writer passes.
CREATE TRIGGER "run_findings_set_tenant_id" BEFORE INSERT ON "run_findings" FOR EACH ROW EXECUTE FUNCTION set_run_tenant_id();
--> statement-breakpoint
-- No policies on purpose (0017): closes Supabase's automatic API to the table.
ALTER TABLE "run_findings" ENABLE ROW LEVEL SECURITY;
