import { AuditRepository, ExplorationCacheRepository, UserRepository } from "@platform/db";
import { TEST_TENANT_ID } from "@platform/db/testing";
import { hashPassword } from "@platform/security";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, createTestApi, type TestApi } from "../test-support";

let t: TestApi;
beforeAll(async () => {
  t = await createTestApi();
});
afterAll(async () => t?.close());

const entry = {
  selector: "xpath=/html[1]/body[1]/button[1]",
  description: "Add to cart",
  method: "click",
  element: { candidates: [{ strategy: "role" as const, role: "button", name: "Add to cart", exact: true }], chosenIndex: 0, framePath: [] },
};

describe("/v1/exploration-cache (V1.1 F8)", () => {
  it("reports the tenant's entries and reuse; an admin clears it (audited), a member may not", async () => {
    const cache = new ExplorationCacheRepository(t.tdb.db);
    await cache.put(TEST_TENANT_ID, "k1", { origin: "https://shop.example.com", path: "/" }, entry);
    await cache.put(TEST_TENANT_ID, "k2", { origin: "https://shop.example.com", path: "/cart" }, entry);
    await cache.touch(TEST_TENANT_ID, "k1");
    const stats = await t.app.inject({ method: "GET", url: "/v1/exploration-cache", headers: auth });
    expect(stats.json()).toEqual({ entries: 2, hits: 1, lastUsedAt: expect.any(String) });

    const email = `cache-${Date.now()}@example.com`;
    await new UserRepository(t.tdb.db).create({
      tenantId: TEST_TENANT_ID,
      email,
      name: "M",
      role: "member",
      passwordHash: await hashPassword("member password", { N: 1024 }),
    });
    const token = (
      await t.app.inject({ method: "POST", url: "/v1/auth/login", headers: auth, payload: { email, password: "member password" } })
    ).json().token;
    const member = { ...auth, "x-session-token": token };
    expect((await t.app.inject({ method: "GET", url: "/v1/exploration-cache", headers: member })).statusCode).toBe(200);
    expect((await t.app.inject({ method: "DELETE", url: "/v1/exploration-cache", headers: member })).statusCode).toBe(403);

    const cleared = await t.app.inject({ method: "DELETE", url: "/v1/exploration-cache", headers: auth });
    expect(cleared.json()).toEqual({ deleted: 2 });
    expect((await t.app.inject({ method: "GET", url: "/v1/exploration-cache", headers: auth })).json()).toEqual({
      entries: 0,
      hits: 0,
      lastUsedAt: null,
    });
    const audits = await new AuditRepository(t.tdb.db).listByTenant(TEST_TENANT_ID, 1000);
    expect(audits.find((a) => a.action === "exploration_cache.cleared")?.detail).toEqual({ deleted: 2 });
  });
});
