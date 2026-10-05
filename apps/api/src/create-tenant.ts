/**
 * `TENANT_ADMIN_PASSWORD=… pnpm --filter @platform/api create-tenant <id> "<name>" <admin e-mail>` (KI-035): adds a
 * tenant and its first administrator, who then signs in at `/login?org=<id>` and adds the others. The password comes
 * from the environment, never the command line (shell history, `ps`).
 */
import { createLogger, loadEnvOrExit } from "@platform/config";
import { createDb } from "@platform/db";
import { HttpError } from "./errors";
import { createTenantWithAdmin } from "./services/tenant-setup";

const env = loadEnvOrExit();
const log = createLogger({ component: "create-tenant", level: env.LOG_LEVEL });
const [id, name, adminEmail] = process.argv.slice(2);
const adminPassword = process.env.TENANT_ADMIN_PASSWORD ?? "";
if (!id || !name || !adminEmail || !adminPassword) {
  console.error('Usage: TENANT_ADMIN_PASSWORD=… pnpm --filter @platform/api create-tenant <id> "<name>" <admin e-mail>');
  process.exit(1);
}

const handle = createDb(env.DATABASE_URL);
try {
  await createTenantWithAdmin({ db: handle.db, config: { auth: { sessionTtlHours: env.SESSION_TTL_HOURS } } }, { id, name, adminEmail, adminPassword });
  log.info({ tenantId: id }, "tenant created");
  console.log(`Tenant ${id} created. Its administrator signs in at /login?org=${encodeURIComponent(id)}`);
} catch (err) {
  console.error(err instanceof HttpError ? err.message : err);
  process.exitCode = 1;
} finally {
  await handle.close();
}
