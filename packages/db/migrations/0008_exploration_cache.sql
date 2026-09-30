CREATE TABLE "exploration_cache" (
	"tenant_id" text NOT NULL,
	"key" text NOT NULL,
	"origin" text NOT NULL,
	"path" text NOT NULL,
	"entry" jsonb NOT NULL,
	"hits" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exploration_cache_tenant_id_key_pk" PRIMARY KEY("tenant_id","key")
);
--> statement-breakpoint
ALTER TABLE "exploration_cache" ADD CONSTRAINT "exploration_cache_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "exploration_cache_last_used" ON "exploration_cache" USING btree ("last_used_at");