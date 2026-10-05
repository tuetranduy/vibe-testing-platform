import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventRepository } from "./event-repository";
import { RunRepository } from "./run-repository";
import { storedRequest } from "./test-helpers";
import { OTHER_TENANT_ID, TEST_TENANT_ID, createTestDatabase, type TestDatabase } from "./testing";

let tdb: TestDatabase;
beforeAll(async () => {
  tdb = await createTestDatabase();
});
afterAll(async () => tdb?.drop());

describe("tenant ids on a run's child rows (D6, KI-027)", () => {
  it("every table with a run_id also carries a non-null tenant_id (audit rows name a run only optionally)", async () => {
    const { rows } = await tdb.pool.query<{ table_name: string; nullable: string | null }>(`
      SELECT r.table_name, t.is_nullable AS nullable
        FROM information_schema.columns r
        LEFT JOIN information_schema.columns t
          ON t.table_schema = r.table_schema AND t.table_name = r.table_name AND t.column_name = 'tenant_id'
       WHERE r.table_schema = 'public' AND r.column_name = 'run_id' AND r.table_name <> 'audit_events'`);
    expect(rows.length).toBeGreaterThanOrEqual(13);
    expect(rows.filter((r) => r.nullable !== "NO").map((r) => r.table_name)).toEqual([]);
  });

  it("fills a child row's tenant from its run on insert, whatever the writer passes", async () => {
    const runs = new RunRepository(tdb.db);
    const mine = await runs.create({ tenantId: TEST_TENANT_ID, targetUrl: "https://x.com", request: storedRequest() });
    const theirs = await runs.create({ tenantId: OTHER_TENANT_ID, targetUrl: "https://x.com", request: storedRequest() });
    const events = new EventRepository(tdb.db);
    for (const run of [mine, theirs]) {
      await events.append({ runId: run.id, stage: "QUEUED", type: "stage.started", message: "queued", payload: { stage: "QUEUED" } });
    }
    // A raw insert naming the wrong tenant still gets the run's.
    await tdb.db.execute(
      sql`INSERT INTO test_plans (run_id, json, tenant_id) VALUES (${theirs.id}, '{}'::jsonb, ${TEST_TENANT_ID})`,
    );
    const tenantOf = async (table: string, runId: string) =>
      (await tdb.pool.query<{ tenant_id: string }>(`SELECT tenant_id FROM ${table} WHERE run_id = $1`, [runId])).rows.map((r) => r.tenant_id);
    expect(await tenantOf("test_events", mine.id)).toEqual([TEST_TENANT_ID]);
    expect(await tenantOf("test_events", theirs.id)).toEqual([OTHER_TENANT_ID]);
    expect(await tenantOf("test_plans", theirs.id)).toEqual([OTHER_TENANT_ID]);
  });
});
