import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NameTakenError, TestDataSetRepository } from "./test-data-set-repository";
import { OTHER_TENANT_ID, TEST_TENANT_ID, createTestDatabase, type TestDatabase } from "./testing";

let tdb: TestDatabase;
beforeAll(async () => {
  tdb = await createTestDatabase();
});
afterAll(async () => tdb?.drop());

describe("TestDataSetRepository", () => {
  it("creates, lists by name, updates and removes sets per tenant", async () => {
    const repo = new TestDataSetRepository(tdb.db);
    const b = await repo.create({
      tenantId: TEST_TENANT_ID,
      name: "Shopper B",
      values: { email: "b@demo.test", quantity: 2 },
      createdBy: null,
    });
    const a = await repo.create({ tenantId: TEST_TENANT_ID, name: "Shopper A", values: { email: "a@demo.test" }, createdBy: null });
    expect((await repo.list(TEST_TENANT_ID)).map((s) => s.name)).toEqual(["Shopper A", "Shopper B"]);
    expect(await repo.list(OTHER_TENANT_ID)).toEqual([]);
    expect(await repo.find(OTHER_TENANT_ID, a.id)).toBeNull();

    const updated = await repo.update(TEST_TENANT_ID, b.id, { name: "Shopper B2", values: { email: "b2@demo.test", vip: true } });
    expect(updated).toMatchObject({ name: "Shopper B2", values: { email: "b2@demo.test", vip: true } });
    expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(b.updatedAt.getTime());
    expect(await repo.update(OTHER_TENANT_ID, b.id, { name: "x", values: {} })).toBeNull();

    expect(await repo.remove(OTHER_TENANT_ID, a.id)).toBe(false);
    expect(await repo.remove(TEST_TENANT_ID, a.id)).toBe(true);
    expect(await repo.find(TEST_TENANT_ID, a.id)).toBeNull();
  });

  it("refuses a duplicate name in the tenant, and values the contract refuses", async () => {
    const repo = new TestDataSetRepository(tdb.db);
    await repo.create({ tenantId: TEST_TENANT_ID, name: "Dup", values: {}, createdBy: null });
    await expect(repo.create({ tenantId: TEST_TENANT_ID, name: "Dup", values: {}, createdBy: null })).rejects.toBeInstanceOf(
      NameTakenError,
    );
    await repo.create({ tenantId: OTHER_TENANT_ID, name: "Dup", values: {}, createdBy: null });
    await expect(
      repo.create({ tenantId: TEST_TENANT_ID, name: "Bad key", values: { "not a key": "x" }, createdBy: null }),
    ).rejects.toThrow();
  });
});
