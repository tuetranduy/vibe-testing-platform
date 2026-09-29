/**
 * Test helpers: every test file gets its own database cloned from a migrated template.
 * TEST_DATABASE_URL must point at a role allowed to CREATE DATABASE (compose: platform/platform).
 */
import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { createDb, ensureTenant, MIGRATIONS_FOLDER, runMigrations, type DbHandle } from "./client";

export const TEST_TENANT_ID = "t_default";
export const OTHER_TENANT_ID = "t_other";

export const TEST_ADMIN_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://platform:platform@localhost:5432/platform";

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

function migrationsHash(): string {
  const h = createHash("sha256");
  for (const f of readdirSync(MIGRATIONS_FOLDER).filter((f) => f.endsWith(".sql")).sort()) {
    h.update(f).update(readFileSync(join(MIGRATIONS_FOLDER, f)));
  }
  return h.digest("hex").slice(0, 12);
}

let templatePromise: Promise<string> | null = null;

export function ensureTemplate(): Promise<string> {
  templatePromise ??= (async () => {
    const template = `platform_tpl_${migrationsHash()}`;
    const admin = new pg.Client({ connectionString: TEST_ADMIN_URL });
    await admin.connect();
    try {
      await admin.query("SELECT pg_advisory_lock(727274)");
      const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [template]);
      if (exists.rowCount === 0) {
        const building = `${template}_build_${randomBytes(4).toString("hex")}`;
        await admin.query(`CREATE DATABASE "${building}"`);
        const h = createDb(withDatabase(TEST_ADMIN_URL, building), { max: 1 });
        try {
          await runMigrations(h.db);
          await ensureTenant(h.db, TEST_TENANT_ID);
          await ensureTenant(h.db, OTHER_TENANT_ID, "Other tenant");
        } finally {
          await h.close();
        }
        await admin.query(`ALTER DATABASE "${building}" RENAME TO "${template}"`);
      }
    } finally {
      await admin.query("SELECT pg_advisory_unlock(727274)").catch(() => {});
      await admin.end();
    }
    return template;
  })();
  return templatePromise;
}

export interface TestDatabase extends DbHandle {
  url: string;
  drop(): Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const template = await ensureTemplate();
  const name = `platform_test_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: TEST_ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);
  } finally {
    await admin.end();
  }
  const url = withDatabase(TEST_ADMIN_URL, name);
  const handle = createDb(url, { max: 20 });
  return {
    ...handle,
    url,
    async drop() {
      await handle.close();
      const a = new pg.Client({ connectionString: TEST_ADMIN_URL });
      await a.connect();
      try {
        await a.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await a.end();
      }
    },
  };
}
export { storedRequest } from "./test-helpers";
