ALTER TABLE "run_logs" ADD COLUMN "seq" bigserial NOT NULL;--> statement-breakpoint
CREATE INDEX "run_logs_run_seq" ON "run_logs" USING btree ("run_id","seq");