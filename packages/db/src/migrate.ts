/** CLI: apply migrations and seed the default tenant. Used by `pnpm db:migrate` and container start-up. */
import { createDb, ensureTenant, runMigrations } from "./client";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const tenantId = process.env.DEFAULT_TENANT_ID ?? "t_default";
const handle = createDb(url, { max: 1 });
try {
  await runMigrations(handle.db);
  await ensureTenant(handle.db, tenantId);
  console.log(`migrations applied; tenant ${tenantId} ready`);
} finally {
  await handle.close();
}
