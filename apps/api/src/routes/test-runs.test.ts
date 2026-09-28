import { TestRunSummarySchema } from "@platform/contracts";
import { EventRepository, RunRepository, SecretRepository, schema } from "@platform/db";
import { OTHER_TENANT_ID } from "@platform/db/testing";
import { runCancelChannel } from "@platform/event-bus";
import { decryptSecret } from "@platform/security";
import { eq } from "drizzle-orm";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { REDIS_URL, SECRETS_KEY, auth, createTestApi, validBody, type TestApi } from "../test-support";

let t: TestApi;
beforeAll(async () => {
  t = await createTestApi();
});
afterAll(async () => t?.close());
beforeEach(() => {
  t.queue.fail = false;
  t.deps.config.maxActiveRunsPerTenant = 100;
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  t.app.inject({ method: "POST", url: "/v1/test-runs", headers: { ...auth, ...headers }, payload: body as object });

describe("auth", () => {
  it.each([undefined, "Bearer wrong-token", "Basic abc", `Bearer ${"x".repeat(200)}`])("rejects %s with 401", async (h) => {
    const res = await t.app.inject({ method: "GET", url: "/v1/test-runs", headers: h ? { authorization: h } : {} });
    expect(res.statusCode).toBe(401);
  });

  it("leaves /healthz open", async () => {
    expect((await t.app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
  });
});

describe("POST /v1/test-runs", () => {
  it("creates a QUEUED run and enqueues analyze-run with { runId } only", async () => {
    const res = await post(validBody());
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body).toEqual({ runId: expect.stringMatching(/^run_/), lifecycle: "QUEUED", eventsUrl: `/v1/test-runs/${body.runId}/events` });
    expect(t.queue.analyze).toContain(body.runId);
    const events = await new EventRepository(t.tdb.db).listAfter(body.runId, 0);
    expect(events.map((e) => e.type)).toEqual(["run.created"]);
    expect(events[0]!.payload).toEqual({ targetHost: "shop.example.com" });
  });

  it("never returns or persists secret values; secrets are encrypted", async () => {
    const res = await post(validBody({ secrets: { password: "hunter2-long-secret" }, testData: { email: "qa@demo.test" } }));
    expect(res.statusCode).toBe(202);
    expect(res.body).not.toContain("hunter2");
    const { runId } = res.json();
    const [row] = await t.tdb.db.select().from(schema.testRuns).where(eq(schema.testRuns.id, runId));
    expect(JSON.stringify(row)).not.toContain("hunter2");
    expect((row!.requestJson as { secretNames: string[] }).secretNames).toEqual(["password"]);
    const [secret] = await new SecretRepository(t.tdb.db).listActive(runId);
    expect(secret!.ciphertext.toString("utf8")).not.toContain("hunter2");
    expect(decryptSecret(secret!, { runId, name: "password" }, SECRETS_KEY)).toBe("hunter2-long-secret");
    const events = await new EventRepository(t.tdb.db).listAfter(runId, 0);
    expect(JSON.stringify(events)).not.toContain("hunter2");
  });

  it("redacts secret values that also appear in the requirement text or test data", async () => {
    const res = await post(
      validBody({
        requirement: "Log in with password hunter2-long-secret and check the account page.",
        secrets: { login_password: "hunter2-long-secret" },
        testData: { email: "qa@demo.test", password: "hunter2-long-secret", note: "pw is hunter2-long-secret" },
      }),
    );
    expect(res.statusCode).toBe(202);
    const { runId } = res.json();
    const [row] = await t.tdb.db.select().from(schema.testRuns).where(eq(schema.testRuns.id, runId));
    expect(JSON.stringify(row)).not.toContain("hunter2");
    const stored = row!.requestJson as { requirement: string; testData: Record<string, string> };
    expect(stored.requirement).toBe("Log in with password [REDACTED] and check the account page.");
    expect(stored.testData.email).toBe("qa@demo.test");
    const summary = await t.app.inject({ method: "GET", url: `/v1/test-runs/${runId}`, headers: auth });
    expect(summary.body).not.toContain("hunter2");
  });

  it("returns 400 for malformed JSON", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/v1/test-runs",
      headers: { ...auth, "content-type": "application/json" },
      payload: "{nope",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("INVALID_JSON");
  });

  it("returns 400 with Zod issue paths for an invalid body", async () => {
    const res = await post({ targetUrl: "javascript:alert(1)", requirement: "short" });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
    const paths = body.issues.map((i: { path: string[] }) => i.path.join("."));
    expect(paths).toContain("targetUrl");
    expect(paths).toContain("requirement");
  });

  it.each(["http://127.0.0.1", "https://private.test", "http://169.254.169.254/latest", "http://demo-shop:4001"])(
    "returns 422 TARGET_NOT_ALLOWED for %s",
    async (targetUrl) => {
      const res = await post(validBody({ targetUrl }));
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe("TARGET_NOT_ALLOWED");
    },
  );

  it("allows an allowlisted private host:port", async () => {
    expect((await post(validBody({ targetUrl: "http://demo-shop:4000/" }))).statusCode).toBe(202);
  });

  it("is idempotent: same key + same body → same run; different body → 409", async () => {
    const key = `idem-${Date.now()}`;
    const a = await post(validBody({ secrets: { password: "abcd1234" } }), { "idempotency-key": key });
    const b = await post(validBody({ secrets: { password: "abcd1234" } }), { "idempotency-key": key });
    expect(a.statusCode).toBe(202);
    expect(b.statusCode).toBe(202);
    expect(b.json().runId).toBe(a.json().runId);
    const rows = await t.tdb.db.select().from(schema.testRuns).where(eq(schema.testRuns.idempotencyKey, key));
    expect(rows).toHaveLength(1);
    const c = await post(validBody({ secrets: { password: "different" } }), { "idempotency-key": key });
    expect(c.statusCode).toBe(409);
    expect(c.json().code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("handles concurrent creates with one idempotency key as one run", async () => {
    const key = `idem-race-${Date.now()}`;
    const results = await Promise.all([1, 2, 3].map(() => post(validBody(), { "idempotency-key": key })));
    expect(results.map((r) => r.statusCode)).toEqual([202, 202, 202]);
    expect(new Set(results.map((r) => r.json().runId)).size).toBe(1);
  });

  it("returns 429 when the tenant has too many active runs", async () => {
    t.deps.config.maxActiveRunsPerTenant = 0;
    const res = await post(validBody());
    expect(res.statusCode).toBe(429);
    expect(res.json().code).toBe("TOO_MANY_ACTIVE_RUNS");
  });

  it("lets a client retry with the same Idempotency-Key after a 503", async () => {
    const key = `idem-503-${Date.now()}`;
    t.queue.fail = true;
    const first = await post(validBody(), { "idempotency-key": key });
    expect(first.statusCode).toBe(503);
    t.queue.fail = false;
    const retry = await post(validBody(), { "idempotency-key": key });
    expect(retry.statusCode).toBe(202);
    const { runId } = retry.json();
    expect(t.queue.analyze).toContain(runId);
    const summary = (await t.app.inject({ method: "GET", url: `/v1/test-runs/${runId}`, headers: auth })).json();
    expect(summary.lifecycle).toBe("QUEUED");
    const again = await post(validBody(), { "idempotency-key": key });
    expect(again.json().runId).toBe(runId);
  });

  it("marks the run ERRORED/INTERNAL and returns 503 when the queue is unavailable", async () => {
    t.queue.fail = true;
    const res = await post(validBody({ secrets: { password: "abcd1234" } }));
    expect(res.statusCode).toBe(503);
    const [row] = await t.tdb.db
      .select()
      .from(schema.testRuns)
      .orderBy(schema.testRuns.createdAt)
      .then((rows) => rows.slice(-1));
    expect(row!.lifecycle).toBe("ERRORED");
    expect(row!.errorCategory).toBe("INTERNAL");
    expect(await new SecretRepository(t.tdb.db).listActive(row!.id)).toHaveLength(0);
    const events = await new EventRepository(t.tdb.db).listAfter(row!.id, 0);
    expect(events.map((e) => e.type)).toEqual(["run.created", "run.errored"]);
  });

  it("production + destructive actions needs the target host confirmed: 400 on options.confirmProductionHost, 202 with it", async () => {
    const bad = await post(validBody({ environment: "production", options: { allowDestructiveActions: true } }));
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: "VALIDATION_FAILED", issues: [{ path: ["options", "confirmProductionHost"] }] });

    const ok = await post(
      validBody({ environment: "production", options: { allowDestructiveActions: true, confirmProductionHost: "shop.example.com" } }),
    );
    expect(ok.statusCode).toBe(202);
    const summary = await t.app.inject({ method: "GET", url: `/v1/test-runs/${ok.json().runId}`, headers: auth });
    expect(summary.json()).toMatchObject({ environment: "production", allowDestructiveActions: true });
  });

  it("answers 400 on targetUrl (not 500) for a URL that doesn't parse, in production with destructive actions", async () => {
    const res = await post(validBody({ targetUrl: "not a url", environment: "production", options: { allowDestructiveActions: true } }));
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("VALIDATION_FAILED");
    expect(res.json().issues.map((i: { path: unknown[] }) => i.path)).toContainEqual(["targetUrl"]);
  });
});

describe("GET /v1/test-runs/:runId and list", () => {
  it("returns a summary", async () => {
    const { runId } = (await post(validBody())).json();
    const res = await t.app.inject({ method: "GET", url: `/v1/test-runs/${runId}`, headers: auth });
    expect(res.statusCode).toBe(200);
    const summary = TestRunSummarySchema.parse(res.json());
    expect(summary.lifecycle).toBe("QUEUED");
    expect(summary.verdict).toBeNull();
    expect(summary.environment).toBe("staging");
    expect(summary.allowDestructiveActions).toBe(false);
  });

  it("returns 404 for another tenant's run", async () => {
    const other = await new RunRepository(t.tdb.db).create({
      tenantId: OTHER_TENANT_ID,
      targetUrl: "https://x.com",
      request: { ...validBody(), environment: "staging", browser: "chromium", testData: {}, secretNames: [], options: {} as never },
    });
    expect((await t.app.inject({ method: "GET", url: `/v1/test-runs/${other.id}`, headers: auth })).statusCode).toBe(404);
    const list = (await t.app.inject({ method: "GET", url: "/v1/test-runs?limit=100", headers: auth })).json();
    expect(list.items.map((i: { runId: string }) => i.runId)).not.toContain(other.id);
  });

  it("lists newest first with a working cursor", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await post(validBody())).json().runId);
    const p1 = (await t.app.inject({ method: "GET", url: "/v1/test-runs?limit=2", headers: auth })).json();
    expect(p1.items.map((i: { runId: string }) => i.runId)).toEqual([ids[2], ids[1]]);
    const p2 = (
      await t.app.inject({ method: "GET", url: `/v1/test-runs?limit=2&cursor=${encodeURIComponent(p1.nextCursor)}`, headers: auth })
    ).json();
    expect(p2.items[0].runId).toBe(ids[0]);
  });

  it("rejects a bad cursor with 400", async () => {
    expect((await t.app.inject({ method: "GET", url: "/v1/test-runs?cursor=zzz", headers: auth })).statusCode).toBe(400);
  });
});

describe("POST /v1/test-runs/:runId/cancel", () => {
  it("cancels a QUEUED run immediately and publishes run.cancelled", async () => {
    const { runId } = (await post(validBody({ secrets: { password: "abcd1234" } }))).json();
    const res = await t.app.inject({ method: "POST", url: `/v1/test-runs/${runId}/cancel`, headers: auth });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ lifecycle: "CANCELLED", cancelReason: "USER_REQUESTED" });
    const events = await new EventRepository(t.tdb.db).listAfter(runId, 0);
    expect(events.map((e) => e.type)).toEqual(["run.created", "run.cancelled"]);
    expect(events[1]!.payload).toEqual({ reason: "USER_REQUESTED" });
    expect(await new SecretRepository(t.tdb.db).listActive(runId)).toHaveLength(0);
  });

  it("cancels an AWAITING_CONFIRMATION run immediately", async () => {
    const { runId } = (await post(validBody())).json();
    const runs = new RunRepository(t.tdb.db);
    await runs.transition(runId, "QUEUED", "ANALYZING_REQUIREMENT");
    await runs.transition(runId, "ANALYZING_REQUIREMENT", "AWAITING_CONFIRMATION");
    const res = await t.app.inject({ method: "POST", url: `/v1/test-runs/${runId}/cancel`, headers: auth });
    expect(res.json().lifecycle).toBe("CANCELLED");
  });

  it("requests cancellation of an active run and signals the worker over Redis", async () => {
    const { runId } = (await post(validBody())).json();
    await new RunRepository(t.tdb.db).transition(runId, "QUEUED", "ANALYZING_REQUIREMENT");
    const sub = new Redis(REDIS_URL);
    const got: string[] = [];
    sub.on("message", (c) => got.push(c));
    await sub.subscribe(runCancelChannel(runId));
    const res = await t.app.inject({ method: "POST", url: `/v1/test-runs/${runId}/cancel`, headers: auth });
    expect(res.statusCode).toBe(202);
    expect(res.json().lifecycle).toBe("ANALYZING_REQUIREMENT");
    const run = await new RunRepository(t.tdb.db).getById(runId);
    expect(run.cancelRequestedAt).toBeInstanceOf(Date);
    await vi.waitFor(() => expect(got).toEqual([runCancelChannel(runId)]));
    sub.disconnect();
  });

  it("accepts an empty body sent with content-type: application/json", async () => {
    const { runId } = (await post(validBody())).json();
    const res = await t.app.inject({
      method: "POST",
      url: `/v1/test-runs/${runId}/cancel`,
      headers: { ...auth, "content-type": "application/json" },
      payload: "",
    });
    expect(res.statusCode).toBe(202);
  });

  it("returns 409 for a terminal run", async () => {
    const { runId } = (await post(validBody())).json();
    await t.app.inject({ method: "POST", url: `/v1/test-runs/${runId}/cancel`, headers: auth });
    const res = await t.app.inject({ method: "POST", url: `/v1/test-runs/${runId}/cancel`, headers: auth });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("RUN_TERMINAL");
  });
});
