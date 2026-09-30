CREATE TABLE "credential_profile_secrets" (
	"profile_id" text NOT NULL,
	"name" text NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"iv" "bytea" NOT NULL,
	"auth_tag" "bytea" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credential_profile_secrets_profile_id_name_pk" PRIMARY KEY("profile_id","name")
);
--> statement-breakpoint
CREATE TABLE "credential_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "credential_profile_secrets" ADD CONSTRAINT "credential_profile_secrets_profile_id_credential_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."credential_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_profiles" ADD CONSTRAINT "credential_profiles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_profiles" ADD CONSTRAINT "credential_profiles_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credential_profiles_tenant_name" ON "credential_profiles" USING btree ("tenant_id","name");