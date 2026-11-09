-- No policies on purpose: this closes Supabase's automatic API (anon, authenticated) to every table.
-- The app connects as the table owner on a role that bypasses row level security.
ALTER TABLE "artifacts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "criterion_results" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "diagnostic_findings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "exploration_steps" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "generated_tests" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "llm_calls" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "observed_facts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "requirement_revisions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "run_secrets" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "test_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "test_plans" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "test_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "llm_provider_keys" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "llm_settings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "run_suggestions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "user_sessions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "test_data_sets" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "credential_profile_secrets" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "credential_profiles" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "exploration_cache" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "suite_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "test_suite_entries" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "test_suites" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "suite_schedules" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "api_tokens" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "run_site_analyses" ENABLE ROW LEVEL SECURITY;
