-- KI-027 (D6): every child row of a run carries the run's tenant. Filled by a trigger from test_runs, so writers
-- never pass it: added nullable, backfilled, then NOT NULL.
CREATE OR REPLACE FUNCTION set_run_tenant_id() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT tenant_id INTO NEW.tenant_id FROM test_runs WHERE id = NEW.run_id;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
ALTER TABLE "criterion_results" ADD COLUMN "tenant_id" text;
--> statement-breakpoint
UPDATE "criterion_results" c SET "tenant_id" = r."tenant_id" FROM "test_runs" r WHERE r."id" = c."run_id";
--> statement-breakpoint
ALTER TABLE "criterion_results" ALTER COLUMN "tenant_id" SET NOT NULL;
--> statement-breakpoint
CREATE TRIGGER "criterion_results_set_tenant_id" BEFORE INSERT ON "criterion_results" FOR EACH ROW EXECUTE FUNCTION set_run_tenant_id();
--> statement-breakpoint
ALTER TABLE "criterion_results" ADD CONSTRAINT "criterion_results_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "diagnostic_findings" ADD COLUMN "tenant_id" text;
--> statement-breakpoint
UPDATE "diagnostic_findings" c SET "tenant_id" = r."tenant_id" FROM "test_runs" r WHERE r."id" = c."run_id";
--> statement-breakpoint
ALTER TABLE "diagnostic_findings" ALTER COLUMN "tenant_id" SET NOT NULL;
--> statement-breakpoint
CREATE TRIGGER "diagnostic_findings_set_tenant_id" BEFORE INSERT ON "diagnostic_findings" FOR EACH ROW EXECUTE FUNCTION set_run_tenant_id();
--> statement-breakpoint
ALTER TABLE "diagnostic_findings" ADD CONSTRAINT "diagnostic_findings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "exploration_steps" ADD COLUMN "tenant_id" text;
--> statement-breakpoint
UPDATE "exploration_steps" c SET "tenant_id" = r."tenant_id" FROM "test_runs" r WHERE r."id" = c."run_id";
--> statement-breakpoint
ALTER TABLE "exploration_steps" ALTER COLUMN "tenant_id" SET NOT NULL;
--> statement-breakpoint
CREATE TRIGGER "exploration_steps_set_tenant_id" BEFORE INSERT ON "exploration_steps" FOR EACH ROW EXECUTE FUNCTION set_run_tenant_id();
--> statement-breakpoint
ALTER TABLE "exploration_steps" ADD CONSTRAINT "exploration_steps_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "generated_tests" ADD COLUMN "tenant_id" text;
--> statement-breakpoint
UPDATE "generated_tests" c SET "tenant_id" = r."tenant_id" FROM "test_runs" r WHERE r."id" = c."run_id";
--> statement-breakpoint
ALTER TABLE "generated_tests" ALTER COLUMN "tenant_id" SET NOT NULL;
--> statement-breakpoint
CREATE TRIGGER "generated_tests_set_tenant_id" BEFORE INSERT ON "generated_tests" FOR EACH ROW EXECUTE FUNCTION set_run_tenant_id();
--> statement-breakpoint
ALTER TABLE "generated_tests" ADD CONSTRAINT "generated_tests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "llm_calls" ADD COLUMN "tenant_id" text;
--> statement-breakpoint
UPDATE "llm_calls" c SET "tenant_id" = r."tenant_id" FROM "test_runs" r WHERE r."id" = c."run_id";
--> statement-breakpoint
ALTER TABLE "llm_calls" ALTER COLUMN "tenant_id" SET NOT NULL;
--> statement-breakpoint
CREATE TRIGGER "llm_calls_set_tenant_id" BEFORE INSERT ON "llm_calls" FOR EACH ROW EXECUTE FUNCTION set_run_tenant_id();
--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "observed_facts" ADD COLUMN "tenant_id" text;
--> statement-breakpoint
UPDATE "observed_facts" c SET "tenant_id" = r."tenant_id" FROM "test_runs" r WHERE r."id" = c."run_id";
--> statement-breakpoint
ALTER TABLE "observed_facts" ALTER COLUMN "tenant_id" SET NOT NULL;
--> statement-breakpoint
CREATE TRIGGER "observed_facts_set_tenant_id" BEFORE INSERT ON "observed_facts" FOR EACH ROW EXECUTE FUNCTION set_run_tenant_id();
--> statement-breakpoint
ALTER TABLE "observed_facts" ADD CONSTRAINT "observed_facts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "requirement_revisions" ADD COLUMN "tenant_id" text;
--> statement-breakpoint
UPDATE "requirement_revisions" c SET "tenant_id" = r."tenant_id" FROM "test_runs" r WHERE r."id" = c."run_id";
--> statement-breakpoint
ALTER TABLE "requirement_revisions" ALTER COLUMN "tenant_id" SET NOT NULL;
--> statement-breakpoint
CREATE TRIGGER "requirement_revisions_set_tenant_id" BEFORE INSERT ON "requirement_revisions" FOR EACH ROW EXECUTE FUNCTION set_run_tenant_id();
--> statement-breakpoint
ALTER TABLE "requirement_revisions" ADD CONSTRAINT "requirement_revisions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "run_secrets" ADD COLUMN "tenant_id" text;
--> statement-breakpoint
UPDATE "run_secrets" c SET "tenant_id" = r."tenant_id" FROM "test_runs" r WHERE r."id" = c."run_id";
--> statement-breakpoint
ALTER TABLE "run_secrets" ALTER COLUMN "tenant_id" SET NOT NULL;
--> statement-breakpoint
CREATE TRIGGER "run_secrets_set_tenant_id" BEFORE INSERT ON "run_secrets" FOR EACH ROW EXECUTE FUNCTION set_run_tenant_id();
--> statement-breakpoint
ALTER TABLE "run_secrets" ADD CONSTRAINT "run_secrets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "run_site_analyses" ADD COLUMN "tenant_id" text;
--> statement-breakpoint
UPDATE "run_site_analyses" c SET "tenant_id" = r."tenant_id" FROM "test_runs" r WHERE r."id" = c."run_id";
--> statement-breakpoint
ALTER TABLE "run_site_analyses" ALTER COLUMN "tenant_id" SET NOT NULL;
--> statement-breakpoint
CREATE TRIGGER "run_site_analyses_set_tenant_id" BEFORE INSERT ON "run_site_analyses" FOR EACH ROW EXECUTE FUNCTION set_run_tenant_id();
--> statement-breakpoint
ALTER TABLE "run_site_analyses" ADD CONSTRAINT "run_site_analyses_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "run_suggestions" ADD COLUMN "tenant_id" text;
--> statement-breakpoint
UPDATE "run_suggestions" c SET "tenant_id" = r."tenant_id" FROM "test_runs" r WHERE r."id" = c."run_id";
--> statement-breakpoint
ALTER TABLE "run_suggestions" ALTER COLUMN "tenant_id" SET NOT NULL;
--> statement-breakpoint
CREATE TRIGGER "run_suggestions_set_tenant_id" BEFORE INSERT ON "run_suggestions" FOR EACH ROW EXECUTE FUNCTION set_run_tenant_id();
--> statement-breakpoint
ALTER TABLE "run_suggestions" ADD CONSTRAINT "run_suggestions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "test_events" ADD COLUMN "tenant_id" text;
--> statement-breakpoint
UPDATE "test_events" c SET "tenant_id" = r."tenant_id" FROM "test_runs" r WHERE r."id" = c."run_id";
--> statement-breakpoint
ALTER TABLE "test_events" ALTER COLUMN "tenant_id" SET NOT NULL;
--> statement-breakpoint
CREATE TRIGGER "test_events_set_tenant_id" BEFORE INSERT ON "test_events" FOR EACH ROW EXECUTE FUNCTION set_run_tenant_id();
--> statement-breakpoint
ALTER TABLE "test_events" ADD CONSTRAINT "test_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "test_plans" ADD COLUMN "tenant_id" text;
--> statement-breakpoint
UPDATE "test_plans" c SET "tenant_id" = r."tenant_id" FROM "test_runs" r WHERE r."id" = c."run_id";
--> statement-breakpoint
ALTER TABLE "test_plans" ALTER COLUMN "tenant_id" SET NOT NULL;
--> statement-breakpoint
CREATE TRIGGER "test_plans_set_tenant_id" BEFORE INSERT ON "test_plans" FOR EACH ROW EXECUTE FUNCTION set_run_tenant_id();
--> statement-breakpoint
ALTER TABLE "test_plans" ADD CONSTRAINT "test_plans_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
