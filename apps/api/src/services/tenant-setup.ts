import { TenantIdSchema } from "@platform/contracts";
import { ensureTenant, tenantExists } from "@platform/db";
import { HttpError } from "../errors";
import { UserService } from "./user-service";

export interface NewTenant {
  id: string;
  name: string;
  adminEmail: string;
  adminPassword: string;
}

/**
 * Adds a tenant and its first administrator (KI-035), for `pnpm --filter @platform/api create-tenant`. Its people
 * sign in at `/login?org=<id>`. Refuses an id already in use, so it never adds an admin to an existing tenant.
 */
export async function createTenantWithAdmin(deps: ConstructorParameters<typeof UserService>[0], input: NewTenant): Promise<void> {
  const id = TenantIdSchema.safeParse(input.id);
  if (!id.success) throw new HttpError(400, "VALIDATION_FAILED", "A tenant id is 1–100 letters, digits, - or _");
  const name = input.name.trim();
  if (!name || name.length > 200) throw new HttpError(400, "VALIDATION_FAILED", "Give the tenant a name (at most 200 characters)");
  if (await tenantExists(deps.db, id.data)) throw new HttpError(409, "TENANT_EXISTS", `Tenant ${id.data} already exists`);
  await deps.db.transaction(async (tx) => {
    await ensureTenant(tx, id.data, name);
    const created = await new UserService({ ...deps, db: tx }).bootstrapAdmin(id.data, input.adminEmail, input.adminPassword);
    if (!created) throw new HttpError(409, "TENANT_EXISTS", `Tenant ${id.data} already has users`);
  });
}
