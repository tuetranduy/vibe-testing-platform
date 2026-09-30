import { ApiTokenRepository, SuiteRunRepository } from "@platform/db";
import { TEST_TENANT_ID } from "@platform/db/testing";
import { apiTokenHash } from "@platform/security";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { memoryTokenThrottle } from "../auth/principal";
import { auth, createTestApi, finishedRunWithTest, signInMember, type TestApi } from "../test-support";

let t: TestApi;
beforeAll(async () => {
  t = await createTestApi();
});
afterAll(async () => t?.close());

type Method = "GET" | "POST" | "PUT" | "DELETE";
const call = (method: Method, url: string, payload: object | undefined, headers: Record<string, string>) =>
  t.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
const withToken = (token: string) => ({ ...auth, "x-api-token": token });

async function newToken(headers: Record<string, string>, body: Record<string, unknown> = {}) {
  const res = await call("POST", "/v1/api-tokens", { name: "CI", scopes: ["suites:run", "results:read"], ...body }, headers);
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; token: string; prefix: string; expiresAt: string | null };
}

describe("/v1/api-tokens (V1.2 F4)", () => {
  it("returns the token once and keeps only its hash; lists and revokes own tokens", async () => {
    const ann = await signInMember(t);
    const created = await newToken(ann.headers);
    expect(created.token).toMatch(/^tap_[A-Za-z0-9_-]{43}$/);
    expect(created.prefix).toBe(created.token.slice(4, 12));
    expect(new Date(created.expiresAt!).getTime()).toBeGreaterThan(Date.now() + 89 * 86_400_000);
    const list = (await call("GET", "/v1/api-tokens", undefined, ann.headers)).json();
    expect(list.items).toMatchObject([{ id: created.id, name: "CI", scopes: ["suites:run", "results:read"], user: { id: ann.userId } }]);
    expect(JSON.stringify(list)).not.toContain(created.token);
    expect((await new ApiTokenRepository(t.tdb.db).findLive(apiTokenHash(created.token)))?.token.id).toBe(created.id);
    expect(t.audit.some((e) => e.action === "token.created" && e.tokenId === created.id)).toBe(true);

    expect((await call("DELETE", `/v1/api-tokens/${created.id}`, undefined, ann.headers)).json().revokedAt).not.toBeNull();
    expect((await call("DELETE", `/v1/api-tokens/${created.id}`, undefined, ann.headers)).statusCode).toBe(404);
    expect((await call("GET", "/v1/suites", undefined, withToken(created.token))).json().code).toBe("TOKEN_INVALID");
  });

  it("needs a web session: the service token and API tokens can't manage tokens", async () => {
    expect((await call("POST", "/v1/api-tokens", { name: "x", scopes: ["results:read"] }, auth)).json().code).toBe("NO_SESSION");
    const ann = await signInMember(t);
    const { token } = await newToken(ann.headers);
    expect((await call("GET", "/v1/api-tokens", undefined, withToken(token))).json().code).toBe("TOKEN_SCOPE");
    expect((await call("POST", "/v1/api-tokens", { name: "x", scopes: ["results:read"] }, withToken(token))).statusCode).toBe(403);
  });

  it("an admin sees and revokes everyone's tokens; a member neither", async () => {
    const ann = await signInMember(t);
    const bob = await signInMember(t);
    const admin = await signInMember(t, "admin");
    const annToken = await newToken(ann.headers);
    expect((await call("GET", "/v1/api-tokens?user=all", undefined, ann.headers)).statusCode).toBe(403);
    expect((await call("DELETE", `/v1/api-tokens/${annToken.id}`, undefined, bob.headers)).statusCode).toBe(404);
    const all = (await call("GET", "/v1/api-tokens?user=all", undefined, admin.headers)).json().items.map((x: { id: string }) => x.id);
    expect(all).toContain(annToken.id);
    expect((await call("DELETE", `/v1/api-tokens/${annToken.id}`, undefined, admin.headers)).statusCode).toBe(200);
  });

  it("refuses bad requests: no scope, an unknown one, an unsupported expiry", async () => {
    const ann = await signInMember(t);
    for (const body of [{ scopes: [] }, { scopes: ["admin"] }, { expiresInDays: 7 }]) {
      expect((await call("POST", "/v1/api-tokens", { name: "x", scopes: ["results:read"], ...body }, ann.headers)).statusCode).toBe(400);
    }
    expect((await newToken(ann.headers, { expiresInDays: null })).expiresAt).toBeNull();
  });
});

describe("calling the API with a token", () => {
  it("acts as its user within its scopes: runs their suite (trigger api) and reads the results; nothing else", async () => {
    const ann = await signInMember(t);
    const suite = (await call("POST", "/v1/suites", { name: `Token suite ${Date.now()}` }, ann.headers)).json();
    await call("POST", `/v1/suites/${suite.id}/entries`, { sourceRunId: await finishedRunWithTest(t, {}, { headers: ann.headers }) }, ann.headers);
    const { token, id } = await newToken(ann.headers, { name: "Deploy pipeline" });

    const found = (await call("GET", `/v1/suites?name=${encodeURIComponent(suite.name)}`, undefined, withToken(token))).json();
    expect(found.items.map((s: { id: string }) => s.id)).toEqual([suite.id]);
    const started = await call("POST", `/v1/suites/${suite.id}/runs`, {}, withToken(token));
    expect(started.statusCode).toBe(202);
    const suiteRun = await new SuiteRunRepository(t.tdb.db).findById(started.json().suiteRunId);
    expect(suiteRun).toMatchObject({ trigger: "api", ownerUserId: ann.userId, context: { token: { id, name: "Deploy pipeline" } } });
    expect((await call("GET", `/v1/suite-runs/${suiteRun!.id}`, undefined, withToken(token))).json().trigger).toBe("api");
    expect((await call("GET", `/v1/test-runs/${started.json().runIds[0]}`, undefined, withToken(token))).statusCode).toBe(200);

    // Outside its routes, whatever its scopes.
    expect((await call("POST", "/v1/test-runs", { targetUrl: "https://shop.example.com", requirement: "Something to check" }, withToken(token))).json().code).toBe(
      "TOKEN_SCOPE",
    );
    expect((await call("DELETE", `/v1/suites/${suite.id}`, undefined, withToken(token))).json().code).toBe("TOKEN_SCOPE");
    expect((await call("GET", "/v1/settings/llm", undefined, withToken(token))).json().code).toBe("TOKEN_SCOPE");
    // Still only its user's: another member's suite is missing.
    const bob = await signInMember(t);
    const bobSuite = (await call("POST", "/v1/suites", { name: `Bob's ${Date.now()}` }, bob.headers)).json();
    expect((await call("POST", `/v1/suites/${bobSuite.id}/runs`, {}, withToken(token))).statusCode).toBe(404);
  });

  it("each scope opens only its routes", async () => {
    const ann = await signInMember(t);
    const readOnly = (await newToken(ann.headers, { scopes: ["results:read"] })).token;
    const runOnly = (await newToken(ann.headers, { scopes: ["suites:run"] })).token;
    const suite = (await call("POST", "/v1/suites", { name: `Scopes ${Date.now()}` }, ann.headers)).json();
    await call("POST", `/v1/suites/${suite.id}/entries`, { sourceRunId: await finishedRunWithTest(t, {}, { headers: ann.headers }) }, ann.headers);
    expect((await call("POST", `/v1/suites/${suite.id}/runs`, {}, withToken(readOnly))).json().code).toBe("TOKEN_SCOPE");
    const started = (await call("POST", `/v1/suites/${suite.id}/runs`, {}, withToken(runOnly))).json();
    expect((await call("GET", `/v1/suite-runs/${started.suiteRunId}`, undefined, withToken(runOnly))).json().code).toBe("TOKEN_SCOPE");
    expect((await call("GET", `/v1/suite-runs/${started.suiteRunId}`, undefined, withToken(readOnly))).statusCode).toBe(200);
  });

  it("refuses a malformed, unknown or expired token, a disabled user's, and both credentials at once", async () => {
    expect((await call("GET", "/v1/suites", undefined, withToken("not-a-token"))).json().code).toBe("TOKEN_INVALID");
    expect((await call("GET", "/v1/suites", undefined, withToken(`tap_${"x".repeat(43)}`))).json().code).toBe("TOKEN_INVALID");
    const ann = await signInMember(t);
    const live = await newToken(ann.headers);
    expect((await call("GET", "/v1/suites", undefined, { ...ann.headers, "x-api-token": live.token })).json().code).toBe("CREDENTIALS_CONFLICT");

    const expired = await newToken(ann.headers);
    await t.tdb.pool.query("UPDATE api_tokens SET expires_at = now() - interval '1 minute' WHERE id = $1", [expired.id]);
    expect((await call("GET", "/v1/suites", undefined, withToken(expired.token))).json().code).toBe("TOKEN_INVALID");

    const admin = await signInMember(t, "admin");
    expect((await t.app.inject({ method: "PATCH", url: `/v1/users/${ann.userId}`, headers: admin.headers, payload: { disabled: true } })).statusCode).toBe(200);
    expect((await call("GET", "/v1/suites", undefined, withToken(live.token))).json().code).toBe("TOKEN_INVALID");
    // Revoked for good: enabling the person again doesn't bring the tokens back.
    expect((await new ApiTokenRepository(t.tdb.db).list(TEST_TENANT_ID, ann.userId)).every((x) => x.revokedAt !== null)).toBe(true);
  });

  it("limits a token to 120 requests a minute and 600 an hour", async () => {
    let now = Date.UTC(2026, 8, 30, 10);
    const limited = await createTestApi({}, { tokenThrottle: memoryTokenThrottle(() => now) });
    try {
      const member = await signInMember(limited);
      const token = (
        await limited.app.inject({ method: "POST", url: "/v1/api-tokens", headers: member.headers, payload: { name: "x", scopes: ["results:read"] } })
      ).json().token;
      const get = () => limited.app.inject({ method: "GET", url: "/v1/suites", headers: withToken(token) });
      for (let i = 0; i < 120; i++) expect((await get()).statusCode).toBe(200);
      const fast = await get();
      expect(fast.statusCode).toBe(429);
      expect(fast.headers["retry-after"]).toBe("60");
      // Refused requests count too: 121 this hour. Three more full minutes make 481, then 119 fit before 600.
      for (let m = 0; m < 3; m++) {
        now += 60_000;
        for (let i = 0; i < 120; i++) expect((await get()).statusCode).toBe(200);
      }
      now += 60_000;
      for (let i = 0; i < 119; i++) expect((await get()).statusCode).toBe(200);
      const slow = await get();
      expect(slow.statusCode).toBe(429);
      expect(slow.headers["retry-after"]).toBe("3600");
      now += 3_600_000;
      expect((await get()).statusCode).toBe(200);
    } finally {
      await limited.close();
    }
  }, 60_000);
});
