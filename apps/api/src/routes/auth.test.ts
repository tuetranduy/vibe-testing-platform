import { AuditRepository, ArtifactRepository, RunRepository, UserRepository } from "@platform/db";
import { OTHER_TENANT_ID, TEST_TENANT_ID, storedRequest } from "@platform/db/testing";
import { hashPassword } from "@platform/security";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTenantWithAdmin } from "../services/tenant-setup";
import { memoryLoginThrottle } from "../services/user-service";
import { auth, createTestApi, validBody, type TestApi } from "../test-support";

let t: TestApi;
beforeAll(async () => {
  t = await createTestApi({}, { loginThrottle: memoryLoginThrottle() });
});
afterAll(async () => t?.close());

const PASSWORD = "correct horse battery";
let seq = 0;

async function makeUser(role: "admin" | "member" = "member", name = "User") {
  const email = `u${++seq}-${Date.now()}@example.com`;
  const user = await new UserRepository(t.tdb.db).create({
    tenantId: TEST_TENANT_ID,
    email,
    name,
    role,
    passwordHash: await hashPassword(PASSWORD, { N: 1024 }),
  });
  return { user, email };
}

async function login(email: string, password = PASSWORD) {
  return t.app.inject({ method: "POST", url: "/v1/auth/login", headers: auth, payload: { email, password } });
}

async function session(role: "admin" | "member" = "member", name = "User") {
  const { user, email } = await makeUser(role, name);
  const res = await login(email);
  expect(res.statusCode).toBe(200);
  const token = res.json().token as string;
  return { user, email, token, headers: { ...auth, "x-session-token": token } };
}

describe("POST /v1/auth/login", () => {
  it("opens a session for the right password and records it", async () => {
    const { user, email } = await makeUser("member", "Lin");
    const res = await login(email.toUpperCase());
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.user).toEqual({ id: user.id, email, name: "Lin", role: "member", disabled: false, createdAt: expect.any(String) });
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now() + 11 * 3_600_000);
    expect(res.body).not.toContain("passwordHash");
    const rows = await new AuditRepository(t.tdb.db).listByTenant(TEST_TENANT_ID, 1000);
    expect(rows.some((r) => r.action === "auth.login" && r.userId === user.id)).toBe(true);
  });

  it("answers the same 401 for a wrong password, an unknown e-mail and a disabled account", async () => {
    const { user, email } = await makeUser();
    const wrong = await login(email, "not the password");
    const unknown = await login("nobody@example.com");
    await new UserRepository(t.tdb.db).update(TEST_TENANT_ID, user.id, { disabledAt: new Date() });
    const disabled = await login(email);
    for (const res of [wrong, unknown, disabled]) {
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ code: "INVALID_CREDENTIALS", message: "The e-mail address or password is not correct" });
    }
    const rows = await new AuditRepository(t.tdb.db).listByTenant(TEST_TENANT_ID, 1000);
    const failed = rows.filter((r) => r.action === "auth.login_failed");
    expect(failed.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(failed)).not.toContain("nobody@example.com");
  });

  it("throttles an e-mail after 10 failures, even for the right password", async () => {
    const { email } = await makeUser();
    for (let i = 0; i < 10; i++) expect((await login(email, "nope-nope-nope")).statusCode).toBe(401);
    const res = await login(email);
    expect(res.statusCode).toBe(429);
    expect(res.json().code).toBe("TOO_MANY_ATTEMPTS");
    expect(res.headers["retry-after"]).toBe("900");
  });

  it("signs in to the organization the request names; an unknown one fails like a wrong password (KI-035)", async () => {
    const email = `other-${Date.now()}@example.com`;
    const other = await new UserRepository(t.tdb.db).create({
      tenantId: OTHER_TENANT_ID,
      email,
      name: "Olga",
      role: "admin",
      passwordHash: await hashPassword(PASSWORD, { N: 1024 }),
    });
    const signIn = (tenant?: string) =>
      t.app.inject({ method: "POST", url: "/v1/auth/login", headers: auth, payload: { email, password: PASSWORD, ...(tenant ? { tenant } : {}) } });

    // Without a tenant: the default one, where this e-mail has no account.
    expect((await signIn()).statusCode).toBe(401);
    const unknown = await signIn("no-such-org");
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json().code).toBe("INVALID_CREDENTIALS");

    const ok = await signIn(OTHER_TENANT_ID);
    expect(ok.statusCode).toBe(200);
    const headers = { ...auth, "x-session-token": ok.json().token as string };
    expect((await t.app.inject({ method: "GET", url: "/v1/auth/me", headers })).json()).toMatchObject({ id: other.id, email });
    // Everything the session reaches is that tenant's: no default-tenant runs, and the runs it creates are its own.
    const mine = await new RunRepository(t.tdb.db).create({ tenantId: TEST_TENANT_ID, targetUrl: "https://x.com", request: storedRequest() });
    const listed = (await t.app.inject({ method: "GET", url: "/v1/test-runs?owner=all", headers })).json().items as { runId: string }[];
    expect(listed.map((r) => r.runId)).not.toContain(mine.id);
    expect((await t.app.inject({ method: "GET", url: `/v1/test-runs/${mine.id}`, headers })).statusCode).toBe(404);
    const audited = await new AuditRepository(t.tdb.db).listByTenant(OTHER_TENANT_ID, 1000);
    expect(audited.some((e) => e.action === "auth.login" && e.userId === other.id)).toBe(true);
  });

  it("create-tenant adds a tenant with its first administrator, who signs in to it; never twice (KI-035)", async () => {
    const id = `acme-${Date.now()}`;
    const input = { id, name: "Acme", adminEmail: "Boss@Acme.example", adminPassword: "a long admin password" };
    await createTenantWithAdmin(t.deps, input);
    await expect(createTenantWithAdmin(t.deps, input)).rejects.toMatchObject({ code: "TENANT_EXISTS" });
    await expect(createTenantWithAdmin(t.deps, { ...input, id: "no spaces" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const res = await t.app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: auth,
      payload: { email: "boss@acme.example", password: "a long admin password", tenant: id },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ role: "admin", email: "boss@acme.example" });
  });

  it("still requires the service bearer token", async () => {
    const { email } = await makeUser();
    const res = await t.app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password: PASSWORD } });
    expect(res.statusCode).toBe(401);
  });
});

describe("sessions", () => {
  it("resolves the session header to the user; an unknown token is 401, never the service", async () => {
    const s = await session("member", "Mia");
    const me = await t.app.inject({ method: "GET", url: "/v1/auth/me", headers: s.headers });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ id: s.user.id, name: "Mia", role: "member" });

    const bad = await t.app.inject({ method: "GET", url: "/v1/test-runs", headers: { ...auth, "x-session-token": "x".repeat(43) } });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().code).toBe("SESSION_INVALID");
  });

  it("logout ends the session", async () => {
    const s = await session();
    expect((await t.app.inject({ method: "POST", url: "/v1/auth/logout", headers: s.headers })).statusCode).toBe(204);
    expect((await t.app.inject({ method: "GET", url: "/v1/auth/me", headers: s.headers })).statusCode).toBe(401);
  });

  it("/v1/auth/me needs a session (the service has no account)", async () => {
    expect((await t.app.inject({ method: "GET", url: "/v1/auth/me", headers: auth })).statusCode).toBe(400);
  });

  it("changing one's password needs the current one and ends the user's other sessions", async () => {
    const s = await session();
    const other = (await login(s.email)).json().token as string;
    const wrong = await t.app.inject({
      method: "PUT",
      url: "/v1/auth/password",
      headers: s.headers,
      payload: { currentPassword: "not it", newPassword: "a brand new passphrase" },
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().issues).toEqual([{ path: ["currentPassword"], message: "The current password is not correct" }]);

    const ok = await t.app.inject({
      method: "PUT",
      url: "/v1/auth/password",
      headers: s.headers,
      payload: { currentPassword: PASSWORD, newPassword: "a brand new passphrase" },
    });
    expect(ok.statusCode).toBe(204);
    expect((await t.app.inject({ method: "GET", url: "/v1/auth/me", headers: s.headers })).statusCode).toBe(200);
    expect((await t.app.inject({ method: "GET", url: "/v1/auth/me", headers: { ...auth, "x-session-token": other } })).statusCode).toBe(
      401,
    );
    expect((await login(s.email, "a brand new passphrase")).statusCode).toBe(200);
  });

  it("lists one's live sessions with their browser, ends one, then every other (KI-034)", async () => {
    const s = await session();
    const phone = (
      await t.app.inject({ method: "POST", url: "/v1/auth/login", headers: { ...auth, "user-agent": "Phone Browser/1.0" }, payload: { email: s.email, password: PASSWORD } })
    ).json().token as string;
    const laptop = (await login(s.email)).json().token as string;
    const someoneElse = await session();
    const list = async (headers = s.headers) => (await t.app.inject({ method: "GET", url: "/v1/auth/sessions", headers })).json().items as Record<string, unknown>[];

    const mine = await list();
    expect(mine).toHaveLength(3);
    expect(mine.filter((x) => x.current)).toHaveLength(1);
    expect(mine.some((x) => x.userAgent === "Phone Browser/1.0")).toBe(true);
    expect(JSON.stringify(mine)).not.toContain(phone);

    // Another user's session is not found, and a session id of one's own ends just that session.
    const theirs = (await list(someoneElse.headers))[0]!.id as string;
    expect((await t.app.inject({ method: "DELETE", url: `/v1/auth/sessions/${theirs}`, headers: s.headers })).statusCode).toBe(404);
    const phoneId = mine.find((x) => x.userAgent === "Phone Browser/1.0")!.id as string;
    expect((await t.app.inject({ method: "DELETE", url: `/v1/auth/sessions/${phoneId}`, headers: s.headers })).statusCode).toBe(204);
    expect((await t.app.inject({ method: "GET", url: "/v1/auth/me", headers: { ...auth, "x-session-token": phone } })).statusCode).toBe(401);
    expect(await list()).toHaveLength(2);

    const others = await t.app.inject({ method: "POST", url: "/v1/auth/sessions/revoke-others", headers: s.headers });
    expect(others.json()).toEqual({ revoked: 1 });
    expect((await t.app.inject({ method: "GET", url: "/v1/auth/me", headers: { ...auth, "x-session-token": laptop } })).statusCode).toBe(401);
    expect(await list()).toEqual([expect.objectContaining({ current: true })]);
    expect(await list(someoneElse.headers)).toHaveLength(1);
    // The service has no sessions.
    expect((await t.app.inject({ method: "GET", url: "/v1/auth/sessions", headers: auth })).statusCode).toBe(400);
  });
});

describe("user management", () => {
  it("is for admins: members get 403", async () => {
    const m = await session("member");
    for (const [method, url] of [
      ["GET", "/v1/users"],
      ["POST", "/v1/users"],
      ["PATCH", `/v1/users/${m.user.id}`],
    ] as const) {
      const res = await t.app.inject({ method, url, headers: m.headers, payload: method === "GET" ? undefined : {} });
      expect(res.statusCode).toBe(403);
    }
  });

  it("an admin creates, renames, demotes, disables and resets users", async () => {
    const a = await session("admin", "Ada");
    const created = await t.app.inject({
      method: "POST",
      url: "/v1/users",
      headers: a.headers,
      payload: { email: "New.Person@Example.com", name: "New Person", password: "initial password" },
    });
    expect(created.statusCode).toBe(201);
    const u = created.json();
    expect(u).toMatchObject({ email: "new.person@example.com", role: "member", disabled: false });

    const dup = await t.app.inject({
      method: "POST",
      url: "/v1/users",
      headers: a.headers,
      payload: { email: "new.person@example.com", name: "Again", password: "initial password" },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().code).toBe("EMAIL_TAKEN");

    const short = await t.app.inject({
      method: "POST",
      url: "/v1/users",
      headers: a.headers,
      payload: { email: "s@example.com", name: "S", password: "short" },
    });
    expect(short.statusCode).toBe(400);

    const theirToken = (await login("new.person@example.com", "initial password")).json().token as string;
    const patched = await t.app.inject({
      method: "PATCH",
      url: `/v1/users/${u.id}`,
      headers: a.headers,
      payload: { name: "Renamed", password: "reset password!" },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().name).toBe("Renamed");
    // A reset password ends their sessions.
    expect(
      (await t.app.inject({ method: "GET", url: "/v1/auth/me", headers: { ...auth, "x-session-token": theirToken } })).statusCode,
    ).toBe(401);

    const disabled = await t.app.inject({ method: "PATCH", url: `/v1/users/${u.id}`, headers: a.headers, payload: { disabled: true } });
    expect(disabled.json().disabled).toBe(true);
    expect((await login("new.person@example.com", "reset password!")).statusCode).toBe(401);

    const list = await t.app.inject({ method: "GET", url: "/v1/users", headers: a.headers });
    expect(list.json().items.map((x: { id: string }) => x.id)).toEqual(expect.arrayContaining([a.user.id, u.id]));
    expect(list.body).not.toContain("scrypt");
  });

  it("never leaves the tenant without an enabled admin", async () => {
    // Every other admin is disabled first, so this one is the last.
    const users = new UserRepository(t.tdb.db);
    const a = await session("admin");
    for (const u of await users.list(TEST_TENANT_ID)) {
      if (u.role === "admin" && u.id !== a.user.id) await users.update(TEST_TENANT_ID, u.id, { disabledAt: new Date() });
    }
    for (const payload of [{ role: "member" }, { disabled: true }]) {
      const res = await t.app.inject({ method: "PATCH", url: `/v1/users/${a.user.id}`, headers: a.headers, payload });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("LAST_ADMIN");
    }
    const b = await session("admin");
    const res = await t.app.inject({ method: "PATCH", url: `/v1/users/${a.user.id}`, headers: b.headers, payload: { role: "member" } });
    expect(res.statusCode).toBe(200);
  });
});

describe("run ownership", () => {
  it("records the creator; members see only their own runs, admins everyone's", async () => {
    const ann = await session("member", "Ann");
    const bob = await session("member", "Bob");
    const admin = await session("admin", "Root");

    const create = async (headers: Record<string, string>) =>
      (await t.app.inject({ method: "POST", url: "/v1/test-runs", headers, payload: validBody() })).json().runId as string;
    const annRun = await create(ann.headers);
    const bobRun = await create(bob.headers);
    const serviceRun = await create(auth);

    const get = (headers: Record<string, string>, runId: string, suffix = "") =>
      t.app.inject({ method: "GET", url: `/v1/test-runs/${runId}${suffix}`, headers });

    const own = await get(ann.headers, annRun);
    expect(own.statusCode).toBe(200);
    expect(own.json().owner).toEqual({ id: ann.user.id, name: "Ann" });
    expect((await get(auth, serviceRun)).json().owner).toBeNull();

    for (const suffix of ["", "/criteria", "/report", "/suggestions", "/artifacts/art_x/url"]) {
      expect((await get(ann.headers, bobRun, suffix)).statusCode).toBe(404);
      expect((await get(ann.headers, serviceRun, suffix)).statusCode).toBe(404);
    }
    const cancel = await t.app.inject({ method: "POST", url: `/v1/test-runs/${bobRun}/cancel`, headers: ann.headers });
    expect(cancel.statusCode).toBe(404);

    const annList = (await t.app.inject({ method: "GET", url: "/v1/test-runs?limit=100&owner=all", headers: ann.headers })).json();
    expect(annList.items.map((r: { runId: string }) => r.runId)).toEqual([annRun]);

    const adminAll = (await t.app.inject({ method: "GET", url: "/v1/test-runs?limit=100", headers: admin.headers })).json();
    expect(adminAll.items.map((r: { runId: string }) => r.runId)).toEqual(expect.arrayContaining([annRun, bobRun, serviceRun]));
    const adminMine = (await t.app.inject({ method: "GET", url: "/v1/test-runs?limit=100&owner=me", headers: admin.headers })).json();
    expect(adminMine.items).toEqual([]);
    expect((await get(admin.headers, bobRun)).statusCode).toBe(200);
  });

  it("does not replay another user's Idempotency-Key", async () => {
    const ann = await session("member");
    const bob = await session("member");
    const key = `key-${Date.now()}`;
    const first = await t.app.inject({
      method: "POST",
      url: "/v1/test-runs",
      headers: { ...ann.headers, "idempotency-key": key },
      payload: validBody(),
    });
    expect(first.statusCode).toBe(202);
    const other = await t.app.inject({
      method: "POST",
      url: "/v1/test-runs",
      headers: { ...bob.headers, "idempotency-key": key },
      payload: validBody(),
    });
    expect(other.statusCode).toBe(409);
  });

  it("records a reveal durably with the user who made it (KI-028)", async () => {
    const ann = await session("member", "Revealer");
    const run = await new RunRepository(t.tdb.db).create({
      tenantId: TEST_TENANT_ID,
      targetUrl: "https://shop.example.com",
      request: storedRequest(),
      ownerUserId: ann.user.id,
    });
    const artifact = await new ArtifactRepository(t.tdb.db).create({
      tenantId: TEST_TENANT_ID,
      runId: run.id,
      type: "SCREENSHOT",
      objectKey: `k/${run.id}.png`,
      sha256: "0".repeat(64),
      bytes: 1,
      contentType: "image/png",
      sensitivity: "SECRET_BEARING",
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const res = await t.app.inject({
      method: "GET",
      url: `/v1/test-runs/${run.id}/artifacts/${artifact.id}/url?reveal=true`,
      headers: ann.headers,
    });
    expect(res.statusCode).toBe(200);
    const rows = await new AuditRepository(t.tdb.db).listByTenant(TEST_TENANT_ID, 1000);
    expect(rows.find((r) => r.action === "artifact.reveal" && r.runId === run.id)).toMatchObject({
      userId: ann.user.id,
      detail: { artifactId: artifact.id, type: "SCREENSHOT" },
    });
  });
});

describe("settings", () => {
  it("members read the LLM settings but cannot change them", async () => {
    const m = await session("member");
    expect((await t.app.inject({ method: "GET", url: "/v1/settings/llm", headers: m.headers })).statusCode).toBe(200);
    const put = await t.app.inject({
      method: "PUT",
      url: "/v1/settings/llm",
      headers: m.headers,
      payload: { defaults: { model: "fake", reasoning: "default" } },
    });
    expect(put.statusCode).toBe(403);
    const key = await t.app.inject({ method: "PUT", url: "/v1/settings/llm/keys/gemini", headers: m.headers, payload: { apiKey: null } });
    expect(key.statusCode).toBe(403);
  });
});
