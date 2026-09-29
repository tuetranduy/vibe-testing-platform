ALTER TYPE "public"."cancel_reason" ADD VALUE 'SELECTION_EXPIRED';--> statement-breakpoint
ALTER TYPE "public"."run_lifecycle" ADD VALUE 'SURVEYING' BEFORE 'ANALYZING_REQUIREMENT';--> statement-breakpoint
ALTER TYPE "public"."run_lifecycle" ADD VALUE 'AWAITING_SELECTION' BEFORE 'ANALYZING_REQUIREMENT';--> statement-breakpoint
CREATE TABLE "run_suggestions" (
	"run_id" text PRIMARY KEY NOT NULL,
	"json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "run_suggestions" ADD CONSTRAINT "run_suggestions_run_id_test_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."test_runs"("id") ON DELETE cascade ON UPDATE no action;