import type { CachedElement } from "@platform/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ExplorationCacheRepository } from "./exploration-cache-repository";
import { OTHER_TENANT_ID, TEST_TENANT_ID, createTestDatabase, type TestDatabase } from "./testing";

let tdb: TestDatabase;
beforeAll(async () => {
  tdb = await createTestDatabase();
});
afterAll(async () => tdb?.drop());

const entry = (name: string): CachedElement => ({
  selector: "xpath=/html[1]/body[1]/button[1]",
  description: `the ${name} button`,
  method: "click",
  element: { candidates: [{ strategy: "role", role: "button", name, exact: true }], chosenIndex: 0, framePath: [] },
});
const where = { origin: "https://shop.example.com", path: "/" };

describe("ExplorationCacheRepository (V1.1 F8)", () => {
  it("puts, gets, replaces and counts reuse per tenant", async () => {
    const cache = new ExplorationCacheRepository(tdb.db);
    expect(await cache.get(TEST_TENANT_ID, "k1")).toBeNull();
    await cache.put(TEST_TENANT_ID, "k1", where, entry("Add to cart"));
    expect(await cache.get(TEST_TENANT_ID, "k1")).toEqual(entry("Add to cart"));
    expect(await cache.get(OTHER_TENANT_ID, "k1")).toBeNull();
    await cache.put(TEST_TENANT_ID, "k1", where, entry("Buy"));
    expect((await cache.get(TEST_TENANT_ID, "k1"))?.description).toBe("the Buy button");
    await cache.touch(TEST_TENANT_ID, "k1");
    await cache.touch(TEST_TENANT_ID, "k1");
    expect(await cache.stats(TEST_TENANT_ID)).toMatchObject({ entries: 1, hits: 2, lastUsedAt: expect.any(Date) });
    expect(await cache.stats(OTHER_TENANT_ID)).toEqual({ entries: 0, hits: 0, lastUsedAt: null });
  });

  it("ignores an entry that no longer parses", async () => {
    const cache = new ExplorationCacheRepository(tdb.db);
    await tdb.pool.query(
      "INSERT INTO exploration_cache (tenant_id, key, origin, path, entry) VALUES ($1, 'bad', 'o', '/', '{\"selector\":1}')",
      [TEST_TENANT_ID],
    );
    expect(await cache.get(TEST_TENANT_ID, "bad")).toBeNull();
  });

  it("clears a tenant, and retention deletes entries unused for long", async () => {
    const cache = new ExplorationCacheRepository(tdb.db);
    await cache.put(OTHER_TENANT_ID, "old", where, entry("Old"));
    await cache.put(OTHER_TENANT_ID, "new", where, entry("New"));
    await tdb.pool.query("UPDATE exploration_cache SET last_used_at = now() - interval '40 days' WHERE key = 'old'");
    expect(await cache.deleteUnusedSince(new Date(Date.now() - 30 * 86_400_000))).toBe(1);
    expect(await cache.get(OTHER_TENANT_ID, "new")).not.toBeNull();
    expect(await cache.clear(OTHER_TENANT_ID)).toBe(1);
    expect(await cache.stats(OTHER_TENANT_ID)).toMatchObject({ entries: 0 });
  });
});
