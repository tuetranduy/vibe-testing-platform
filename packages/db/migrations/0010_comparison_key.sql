ALTER TABLE "test_runs" ADD COLUMN "comparison_key" text;--> statement-breakpoint
CREATE INDEX "test_runs_tenant_comparison_created" ON "test_runs" USING btree ("tenant_id","comparison_key","created_at");--> statement-breakpoint
-- Back-fill (V1.2 F2): runs of the same test share a key: SHA-256 of the target URL and the requirement text with
-- its whitespace collapsed (comparisonKeyOf in ids.ts); reruns inherit the key of the run they reran, at any depth.
UPDATE "test_runs"
SET "comparison_key" = encode(sha256(convert_to("target_url" || E'\n' || btrim(regexp_replace("request_json"->>'requirement', '[ \t\n\r\f\v]+', ' ', 'g')), 'UTF8')), 'hex')
WHERE "request_json"->>'rerunOf' IS NULL
  AND btrim(regexp_replace(coalesce("request_json"->>'requirement', ''), '[ \t\n\r\f\v]+', ' ', 'g')) <> '';--> statement-breakpoint
WITH RECURSIVE "chain" ("id", "root") AS (
  SELECT "id", "id" FROM "test_runs" WHERE "request_json"->>'rerunOf' IS NULL
  UNION ALL
  SELECT r."id", c."root" FROM "test_runs" r JOIN "chain" c ON r."request_json"->>'rerunOf' = c."id"
)
UPDATE "test_runs" AS t
SET "comparison_key" = root."comparison_key"
FROM "chain" c JOIN "test_runs" root ON root."id" = c."root"
WHERE t."id" = c."id" AND c."id" <> c."root";
