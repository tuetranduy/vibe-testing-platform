import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import pg from "pg";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema>;
/** A database handle or an open transaction; repositories accept either. */
export type Executor = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface DbHandle {
  db: Database;
  pool: pg.Pool;
  close(): Promise<void>;
}

export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../migrations", import.meta.url));

export function createDb(databaseUrl: string, opts: { max?: number } = {}): DbHandle {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: opts.max ?? 10 });
  // An idle client error must not crash the process.
  pool.on("error", () => {});
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}

export async function runMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

/** Whether a tenant exists (a sign-in naming another tenant, KI-035). */
export async function tenantExists(db: Executor, tenantId: string): Promise<boolean> {
  const rows = await db.select({ id: schema.tenants.id }).from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1);
  return rows.length > 0;
}

/** Seed the default tenant (D6). Idempotent. */
export async function ensureTenant(db: Executor, tenantId: string, name = "Default tenant"): Promise<void> {
  await db.insert(schema.tenants).values({ id: tenantId, name }).onConflictDoNothing();
}
