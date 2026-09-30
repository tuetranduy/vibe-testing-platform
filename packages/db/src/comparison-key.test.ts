import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_FOLDER } from "./client";
import { comparisonKeyOf } from "./ids";
import { RunRepository } from "./run-repository";
import { OTHER_TENANT_ID, TEST_TENANT_ID, createTestDatabase, storedRequest, type TestDatabase } from "./testing";

let tdb: TestDatabase;
beforeAll(async () => {
  tdb = await createTestDatabase();
});
afterAll(async () => tdb?.drop());

const create = (requirement: string, extra: { rerunOf?: string; tenantId?: string; comparisonKey?: string | null } = {}) =>
  new RunRepository(tdb.db).create({
    tenantId: extra.tenantId ?? TEST_TENANT_ID,
    targetUrl: "https://shop.example.com",
    request: storedRequest({ requirement, ...(extra.rerunOf ? { rerunOf: extra.rerunOf } : {}) }),
    ...(extra.comparisonKey !== undefined ? { comparisonKey: extra.comparisonKey } : {}),
  });

describe("comparison keys (V1.2 F2)", () => {
  it("are equal for the same URL and requirement up to whitespace, and null for a blank requirement", () => {
    const a = comparisonKeyOf("https://shop.example.com", "Add a product\n\tto the cart.");
    expect(a).toBe(comparisonKeyOf("https://shop.example.com", "  Add a product to the cart. "));
    expect(a).not.toBe(comparisonKeyOf("https://shop.example.com/", "Add a product to the cart."));
    expect(a).not.toBe(comparisonKeyOf("https://shop.example.com", "add a product to the cart."));
    expect(comparisonKeyOf("https://shop.example.com", " \n ")).toBeNull();
  });

  it("are set on creation; a blank run gets one from the first requirement it is given, and keeps it", async () => {
    const runs = new RunRepository(tdb.db);
    const run = await create("Add a product to the cart.");
    expect(run.comparisonKey).toBe(comparisonKeyOf("https://shop.example.com", "Add a product to the cart."));
    const blank = await create("");
    expect(blank.comparisonKey).toBeNull();
    await runs.setRequirement(blank.id, "Search for an iPhone.");
    const chosen = comparisonKeyOf("https://shop.example.com", "Search for an iPhone.");
    expect((await runs.getById(blank.id)).comparisonKey).toBe(chosen);
    await runs.setRequirement(blank.id, "Search for an [redacted].");
    expect((await runs.getById(blank.id)).comparisonKey).toBe(chosen);
  });

  it("find the previous completed run of the same test in the caller's scope", async () => {
    const runs = new RunRepository(tdb.db);
    const text = `Find the previous run ${Date.now()}`;
    const complete = async (id: string) => {
      await runs.transition(id, "QUEUED", "RUNNING_PLAYWRIGHT");
      await runs.transition(id, "RUNNING_PLAYWRIGHT", "GENERATING_REPORT");
      await runs.transition(id, "GENERATING_REPORT", "COMPLETED", { verdict: "PASSED" });
    };
    const first = await create(text);
    await complete(first.id);
    const errored = await create(text);
    await runs.transition(errored.id, "QUEUED", "ERRORED", { errorCategory: "INTERNAL" });
    const rerun = await create(text, { rerunOf: first.id, comparisonKey: first.comparisonKey });
    await complete(rerun.id);
    const latest = await create(text);
    await create(text, { tenantId: OTHER_TENANT_ID });

    const scope = { tenantId: TEST_TENANT_ID };
    expect((await runs.findPreviousComparable(scope, await runs.getById(latest.id)))?.id).toBe(rerun.id);
    expect((await runs.findPreviousComparable(scope, await runs.getById(rerun.id)))?.id).toBe(first.id);
    expect(await runs.findPreviousComparable(scope, await runs.getById(first.id))).toBeNull();
    expect(await runs.findPreviousComparable({ tenantId: TEST_TENANT_ID, ownerUserId: "usr_nobody" }, await runs.getById(latest.id))).toBeNull();
    expect((await runs.listComparable(scope, await runs.getById(first.id))).map((r) => r.id)).toEqual([rerun.id]);
  });

  it("the migration's back-fill computes the same keys, and gives reruns their root's", async () => {
    const runs = new RunRepository(tdb.db);
    const text = `  Back-fill\r\nthis\f requirement\v ${Date.now()} `;
    const source = await create(text);
    const rerun = await create(text, { rerunOf: source.id, comparisonKey: null });
    const rerunOfRerun = await create(text, { rerunOf: rerun.id, comparisonKey: null });
    const blank = await create(" ");
    await tdb.db.execute(sql`UPDATE test_runs SET comparison_key = NULL`);

    const migration = readFileSync(join(MIGRATIONS_FOLDER, "0010_comparison_key.sql"), "utf8").split("--> statement-breakpoint");
    for (const statement of migration.slice(-2)) await tdb.db.execute(sql.raw(statement));

    const expected = comparisonKeyOf("https://shop.example.com", text);
    expect(expected).not.toBeNull();
    for (const id of [source.id, rerun.id, rerunOfRerun.id]) expect((await runs.getById(id)).comparisonKey).toBe(expected);
    expect((await runs.getById(blank.id)).comparisonKey).toBeNull();
  });
});
