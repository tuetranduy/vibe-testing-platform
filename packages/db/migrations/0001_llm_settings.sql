CREATE TYPE "public"."reasoning_level" AS ENUM('default', 'minimal', 'low', 'medium', 'high');--> statement-breakpoint
CREATE TABLE "llm_provider_keys" (
	"tenant_id" text NOT NULL,
	"provider" text NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"iv" "bytea" NOT NULL,
	"auth_tag" "bytea" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_provider_keys_tenant_id_provider_pk" PRIMARY KEY("tenant_id","provider"),
	CONSTRAINT "llm_provider_keys_provider" CHECK ("llm_provider_keys"."provider" IN ('anthropic', 'gemini'))
);
--> statement-breakpoint
CREATE TABLE "llm_settings" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"default_model" text NOT NULL,
	"default_reasoning" "reasoning_level" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "llm_provider_keys" ADD CONSTRAINT "llm_provider_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_settings" ADD CONSTRAINT "llm_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;