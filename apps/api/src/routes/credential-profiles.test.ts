import { AuditRepository, SecretRepository, UserRepository, schema } from "@platform/db";
import { TEST_TENANT_ID } from "@platform/db/testing";
import { decryptSecret, hashPassword } from "@platform/security";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SECRETS_KEY, auth, createTestApi, validBody, type TestApi } from "../test-support";

let t: TestApi;
beforeAll(async () => {
  t = await createTestApi();
});
afterAll(async () => t?.close());

const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object, headers: Record<string, string> = auth) =>
  t.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });

async function memberHeaders(): Promise<Record<string, string>> {
  const email = `m-${Date.now()}-${Math.random()}@example.com`;
  await new UserRepository(t.tdb.db).create({
    tenantId: TEST_TENANT_ID,
    email,
    name: "Mem",
    role: "member",
    passwordHash: await hashPassword("member password", { N: 1024 }),
  });
  const token = (await call("POST", "/v1/auth/login", { email, password: "member password" })).json().token as string;
  return { ...auth, "x-session-token": token };
}

describe("/v1/credential-profiles", () => {
  it("creates a profile and never returns or stores a value in plain text", async () => {
    const res = await call("POST", "/v1/credential-profiles", {
      name: "Staging admin",
      description: "The QA admin account",
      secrets: { username: "qa-admin-user", password: "hunter2-long-secret" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ name: "Staging admin", description: "The QA admin account", secretNames: ["password", "username"] });
    expect(res.body).not.toContain("hunter2");
    const list = await call("GET", "/v1/credential-profiles");
    expect(list.body).not.toContain("hunter2");
    const { rows } = await t.tdb.pool.query("SELECT ciphertext FROM credential_profile_secrets");
    expect(rows.map((r: { ciphertext: Buffer }) => r.ciphertext.toString("utf8")).join("")).not.toContain("hunter2");
  });

  it("updates: renames, replaces a value, removes one; refuses to leave none", async () => {
    const p = (
      await call("POST", "/v1/credential-profiles", { name: "Edit me", secrets: { username: "user-one", password: "pass-one-long" } })
    ).json();
    const res = await call("PUT", `/v1/credential-profiles/${p.id}`, {
      name: "Edited",
      secrets: { password: "pass-two-long", username: null, pin: "1234" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: "Edited", secretNames: ["password", "pin"] });
    const empty = await call("PUT", `/v1/credential-profiles/${p.id}`, { secrets: { password: null, pin: null } });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().issues[0]).toEqual({ path: ["secrets"], message: "Keep at least one secret" });
    expect((await call("PUT", "/v1/credential-profiles/cp_missing", { name: "x" })).statusCode).toBe(404);
  });

  it("is managed by admins only; members list and use profiles", async () => {
    const member = await memberHeaders();
    expect((await call("POST", "/v1/credential-profiles", { name: "Nope", secrets: { password: "x-long-pw" } }, member)).statusCode).toBe(
      403,
    );
    const p = (await call("POST", "/v1/credential-profiles", { name: "Shared login", secrets: { password: "shared-pw-long" } })).json();
    expect((await call("PUT", `/v1/credential-profiles/${p.id}`, { name: "x" }, member)).statusCode).toBe(403);
    expect((await call("DELETE", `/v1/credential-profiles/${p.id}`, undefined, member)).statusCode).toBe(403);
    expect((await call("GET", "/v1/credential-profiles", undefined, member)).json().items.map((x: { id: string }) => x.id)).toContain(p.id);
    const run = await call("POST", "/v1/test-runs", validBody({ credentialProfileId: p.id }), member);
    expect(run.statusCode).toBe(202);
  });

  it("refuses duplicates and invalid secret names", async () => {
    await call("POST", "/v1/credential-profiles", { name: "Twice", secrets: { password: "pw-long-1" } });
    expect((await call("POST", "/v1/credential-profiles", { name: "Twice", secrets: { password: "pw-long-1" } })).statusCode).toBe(409);
    expect((await call("POST", "/v1/credential-profiles", { name: "Bad", secrets: { "Not-Valid": "pw-long-1" } })).statusCode).toBe(400);
    expect((await call("POST", "/v1/credential-profiles", { name: "None", secrets: {} })).statusCode).toBe(400);
  });
});

describe("POST /v1/test-runs with credentialProfileId", () => {
  it("copies the profile's values into the run's own encrypted secrets (the request's win) and audits the use", async () => {
    const p = (
      await call("POST", "/v1/credential-profiles", {
        name: "Buyer login",
        secrets: { username: "buyer-user", password: "profile-pw-long" },
      })
    ).json();
    const res = await call("POST", "/v1/test-runs", validBody({ credentialProfileId: p.id, secrets: { password: "typed-pw-long" } }));
    expect(res.statusCode).toBe(202);
    const { runId } = res.json();
    const [row] = await t.tdb.db.select().from(schema.testRuns).where(eq(schema.testRuns.id, runId));
    const stored = row!.requestJson as { secretNames: string[]; credentialProfile: unknown; credentialProfileId?: string };
    expect(stored.secretNames).toEqual(["password", "username"]);
    expect(stored.credentialProfile).toEqual({ id: p.id, name: "Buyer login" });
    expect(stored.credentialProfileId).toBeUndefined();
    const secrets = await new SecretRepository(t.tdb.db).listActive(runId);
    const plain = Object.fromEntries(secrets.map((s) => [s.name, decryptSecret(s, { runId, name: s.name }, SECRETS_KEY)]));
    expect(plain).toEqual({ username: "buyer-user", password: "typed-pw-long" });
    expect((await new SecretRepository(t.tdb.db).listFingerprints(runId)).length).toBe(2);
    const audits = await new AuditRepository(t.tdb.db).listByTenant(TEST_TENANT_ID, 1000);
    expect(audits.find((a) => a.action === "credential_profile.used" && a.runId === runId)?.detail).toEqual({ profileId: p.id });
  });

  it("redacts a profile value that appears in the requirement", async () => {
    const p = (await call("POST", "/v1/credential-profiles", { name: "Leaky login", secrets: { password: "leaky-pw-value" } })).json();
    const res = await call(
      "POST",
      "/v1/test-runs",
      validBody({ credentialProfileId: p.id, requirement: "Log in with leaky-pw-value and see the account." }),
    );
    const [row] = await t.tdb.db.select().from(schema.testRuns).where(eq(schema.testRuns.id, res.json().runId));
    expect(JSON.stringify(row!.requestJson)).not.toContain("leaky-pw-value");
  });

  it("refuses an unknown profile (422), too many secrets together (400) and an unreadable profile (422)", async () => {
    const missing = await call("POST", "/v1/test-runs", validBody({ credentialProfileId: "cp_missing" }));
    expect(missing.statusCode).toBe(422);
    expect(missing.json()).toMatchObject({ code: "CREDENTIAL_PROFILE_NOT_FOUND", issues: [{ path: ["credentialProfileId"] }] });

    const six = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`p${i}`, `value-${i}-long`]));
    const typed = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`t${i}`, `value-${i}-long`]));
    const big = (await call("POST", "/v1/credential-profiles", { name: "Big", secrets: six })).json();
    const tooMany = await call("POST", "/v1/test-runs", validBody({ credentialProfileId: big.id, secrets: typed }));
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.json().issues[0].path).toEqual(["secrets"]);

    const broken = (await call("POST", "/v1/credential-profiles", { name: "Broken", secrets: { password: "will-break-it" } })).json();
    await t.tdb.pool.query("UPDATE credential_profile_secrets SET auth_tag = $1 WHERE profile_id = $2", [Buffer.alloc(16, 0), broken.id]);
    const unreadable = await call("POST", "/v1/test-runs", validBody({ credentialProfileId: broken.id }));
    expect(unreadable.statusCode).toBe(422);
    expect(unreadable.json().code).toBe("CREDENTIAL_PROFILE_UNREADABLE");
    expect(unreadable.body).not.toContain("will-break-it");
  });
});
