import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RunRepository, toRunSummary } from "./run-repository";
import { storedRequest } from "./test-helpers";
import { OTHER_TENANT_ID, TEST_TENANT_ID, createTestDatabase, type TestDatabase } from "./testing";
import { AuditRepository, EmailTakenError, SessionRepository, UserRepository, toUserView } from "./user-repository";

let tdb: TestDatabase;
beforeAll(async () => {
  tdb = await createTestDatabase();
});
afterAll(async () => tdb?.drop());

const hash = (b: number) => Buffer.alloc(32, b);

describe("UserRepository", () => {
  it("creates users with lowercased e-mails, unique per tenant", async () => {
    const users = new UserRepository(tdb.db);
    const u = await users.create({ tenantId: TEST_TENANT_ID, email: " Ann@Example.COM ", name: "Ann", passwordHash: "h", role: "admin" });
    expect(u.email).toBe("ann@example.com");
    expect((await users.findByEmail(TEST_TENANT_ID, "ANN@example.com"))?.id).toBe(u.id);
    await expect(
      users.create({ tenantId: TEST_TENANT_ID, email: "ann@example.com", name: "Dup", passwordHash: "h", role: "member" }),
    ).rejects.toBeInstanceOf(EmailTakenError);
    // Another tenant may use the same address.
    await users.create({ tenantId: OTHER_TENANT_ID, email: "ann@example.com", name: "Ann", passwordHash: "h", role: "member" });
    expect(toUserView(u)).toEqual({
      id: u.id,
      email: "ann@example.com",
      name: "Ann",
      role: "admin",
      disabled: false,
      createdAt: u.createdAt.toISOString(),
    });
    expect(JSON.stringify(toUserView(u))).not.toContain("passwordHash");
  });

  it("updates, counts other active admins and resolves names per tenant", async () => {
    const users = new UserRepository(tdb.db);
    const a = await users.create({ tenantId: TEST_TENANT_ID, email: "boss@example.com", name: "Boss", passwordHash: "h", role: "admin" });
    const m = await users.create({ tenantId: TEST_TENANT_ID, email: "m@example.com", name: "Mo", passwordHash: "h", role: "member" });
    const before = await users.countOtherActiveAdmins(TEST_TENANT_ID, a.id);
    await users.update(TEST_TENANT_ID, m.id, { role: "admin" });
    expect(await users.countOtherActiveAdmins(TEST_TENANT_ID, a.id)).toBe(before + 1);
    await users.update(TEST_TENANT_ID, m.id, { disabledAt: new Date() });
    expect(await users.countOtherActiveAdmins(TEST_TENANT_ID, a.id)).toBe(before);
    expect(await users.update(OTHER_TENANT_ID, m.id, { name: "x" })).toBeNull();
    const names = await users.namesById(TEST_TENANT_ID, [a.id, m.id, "usr_missing"]);
    expect(Object.fromEntries(names)).toEqual({ [a.id]: "Boss", [m.id]: "Mo" });
  });
});

describe("SessionRepository", () => {
  it("finds live sessions only: not expired, revoked or of a disabled user", async () => {
    const users = new UserRepository(tdb.db);
    const sessions = new SessionRepository(tdb.db);
    const u = await users.create({ tenantId: TEST_TENANT_ID, email: "s@example.com", name: "S", passwordHash: "h", role: "member" });
    const future = new Date(Date.now() + 3_600_000);
    const live = await sessions.create({ userId: u.id, tokenHash: hash(1), expiresAt: future });
    await sessions.create({ userId: u.id, tokenHash: hash(2), expiresAt: new Date(Date.now() - 1000) });
    expect((await sessions.findLive(hash(1)))?.user.id).toBe(u.id);
    expect(await sessions.findLive(hash(2))).toBeNull();
    expect(await sessions.findLive(hash(9))).toBeNull();

    await sessions.revoke(live.id);
    expect(await sessions.findLive(hash(1))).toBeNull();

    await sessions.create({ userId: u.id, tokenHash: hash(3), expiresAt: future });
    await users.update(TEST_TENANT_ID, u.id, { disabledAt: new Date() });
    expect(await sessions.findLive(hash(3))).toBeNull();
  });

  it("revokes all of a user's sessions but the one kept", async () => {
    const users = new UserRepository(tdb.db);
    const sessions = new SessionRepository(tdb.db);
    const u = await users.create({ tenantId: TEST_TENANT_ID, email: "r@example.com", name: "R", passwordHash: "h", role: "member" });
    const future = new Date(Date.now() + 3_600_000);
    const keep = await sessions.create({ userId: u.id, tokenHash: hash(11), expiresAt: future });
    await sessions.create({ userId: u.id, tokenHash: hash(12), expiresAt: future });
    await sessions.create({ userId: u.id, tokenHash: hash(13), expiresAt: future });
    expect(await sessions.revokeAllForUser(u.id, keep.id)).toBe(2);
    expect(await sessions.findLive(hash(11))).not.toBeNull();
    expect(await sessions.findLive(hash(12))).toBeNull();
    expect(await sessions.revokeAllForUser(u.id)).toBe(1);
    expect(await sessions.findLive(hash(11))).toBeNull();
  });
});

describe("AuditRepository", () => {
  it("appends rows per tenant", async () => {
    const audit = new AuditRepository(tdb.db);
    await audit.append({ tenantId: OTHER_TENANT_ID, userId: null, action: "auth.login_failed", detail: { emailHash: "abc" } });
    await audit.append({
      tenantId: OTHER_TENANT_ID,
      userId: null,
      action: "artifact.reveal",
      runId: "run_x",
      detail: { artifactId: "art_1" },
    });
    const rows = await audit.listByTenant(OTHER_TENANT_ID);
    expect(rows.map((r) => [r.action, r.runId])).toEqual([
      ["auth.login_failed", null],
      ["artifact.reveal", "run_x"],
    ]);
  });
});

describe("RunRepository scopes", () => {
  it("lists and gets only an owner's runs when scoped to them; summaries name the owner", async () => {
    const users = new UserRepository(tdb.db);
    const runs = new RunRepository(tdb.db);
    const a = await users.create({
      tenantId: TEST_TENANT_ID,
      email: "own-a@example.com",
      name: "Owner A",
      passwordHash: "h",
      role: "member",
    });
    const b = await users.create({
      tenantId: TEST_TENANT_ID,
      email: "own-b@example.com",
      name: "Owner B",
      passwordHash: "h",
      role: "member",
    });
    const ra = await runs.create({
      tenantId: TEST_TENANT_ID,
      targetUrl: "https://shop.example.com",
      request: storedRequest(),
      ownerUserId: a.id,
    });
    const rb = await runs.create({
      tenantId: TEST_TENANT_ID,
      targetUrl: "https://shop.example.com",
      request: storedRequest(),
      ownerUserId: b.id,
    });
    const rn = await runs.create({ tenantId: TEST_TENANT_ID, targetUrl: "https://shop.example.com", request: storedRequest() });

    const mine = await runs.list({ tenantId: TEST_TENANT_ID, ownerUserId: a.id }, { limit: 100 });
    expect(mine.items.map((r) => r.id)).toEqual([ra.id]);
    const all = await runs.list(TEST_TENANT_ID, { limit: 100 });
    expect(all.items.map((r) => r.id)).toEqual(expect.arrayContaining([ra.id, rb.id, rn.id]));

    await expect(runs.getRequired({ tenantId: TEST_TENANT_ID, ownerUserId: a.id }, rb.id)).rejects.toThrow(/not found/i);
    await expect(runs.getRequired({ tenantId: TEST_TENANT_ID, ownerUserId: a.id }, rn.id)).rejects.toThrow(/not found/i);
    expect((await runs.getRequired({ tenantId: TEST_TENANT_ID }, rb.id)).id).toBe(rb.id);

    const names = await users.namesById(TEST_TENANT_ID, [a.id]);
    expect(toRunSummary(ra, undefined, (id) => names.get(id) ?? null).owner).toEqual({ id: a.id, name: "Owner A" });
    expect(toRunSummary(rn).owner).toBeNull();
  });
});
