import { TestRunSummarySchema } from "@platform/contracts";
import { EventRepository, LlmSettingsRepository, ProviderKeyRepository, RunRepository, SecretRepository, schema } from "@platform/db";
import { OTHER_TENANT_ID, TEST_TENANT_ID } from "@platform/db/testing";
import { runCancelChannel } from "@platform/event-bus";
import { decryptSecret, encryptProviderKey } from "@platform/security";
import { eq } from "drizzle-orm";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiLlmConfig } from "../deps";
import { FAKE_LLM, REDIS_URL, SECRETS_KEY, auth, createTestApi, validBody, type TestApi } from "../test-support";

let t: TestApi;
beforeAll(async () => {
  t = await createTestApi();
});
afterAll(async () => t?.close());
beforeEach(() => {
  t.queue.fail = false;
  t.deps.config.maxActiveRunsPerTenant = 100;
  t.deps.config.llm = FAKE_LLM;
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

  it("uses credentials written in the requirement (V1.3.1): the email as test data, the password as an encrypted secret out of the text", async () => {
    const res = await post(validBody({ requirement: "Log in as admin@shop.test with password Adm1n#2026-long and see the account page." }));
    expect(res.statusCode).toBe(202);
    const { runId } = res.json();
    const [row] = await t.tdb.db.select().from(schema.testRuns).where(eq(schema.testRuns.id, runId));
    expect(JSON.stringify(row)).not.toContain("Adm1n#2026-long");
    const request = row!.requestJson as { requirement: string; testData: Record<string, string>; secretNames: string[]; inlineInputs: unknown };
    expect(request.requirement).toBe("Log in as admin@shop.test with password [secret: password] and see the account page.");
    expect(request.testData).toEqual({ email: "admin@shop.test" });
    expect(request.secretNames).toEqual(["password"]);
    expect(request.inlineInputs).toEqual([
      { kind: "secret", name: "password" },
      { kind: "testData", name: "email" },
    ]);
    const [secret] = await new SecretRepository(t.tdb.db).listActive(runId);
    expect(decryptSecret(secret!, { runId, name: "password" }, SECRETS_KEY)).toBe("Adm1n#2026-long");
    const events = await new EventRepository(t.tdb.db).listAfter(runId, 0);
    expect(JSON.stringify(events)).not.toContain("Adm1n#2026-long");
  });

  it("what the user entered wins over what the requirement names (V1.3.1)", async () => {
    const res = await post(
      validBody({
        requirement: "Log in as admin@shop.test with password Adm1n#2026-long and see the account page.",
        testData: { email: "mine@shop.test" },
        secrets: { password: "typed-password-1" },
      }),
    );
    const { runId } = res.json();
    const run = await new RunRepository(t.tdb.db).getById(runId);
    expect(run.request.testData).toEqual({ email: "mine@shop.test" });
    expect(run.request.secretNames).toEqual(["password", "password_2"]);
    expect(run.request.requirement).toContain("[secret: password_2]");
    const secrets = await new SecretRepository(t.tdb.db).listActive(runId);
    const values = Object.fromEntries(secrets.map((s) => [s.name, decryptSecret(s, { runId, name: s.name }, SECRETS_KEY)]));
    expect(values).toEqual({ password: "typed-password-1", password_2: "Adm1n#2026-long" });
  });

  it("keeps secret values that also appear in test data; key-based redaction and the requirement's own password still apply", async () => {
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
    const stored = row!.requestJson as { requirement: string; testData: Record<string, string> };
    // V1.3.1: a password written in the requirement that is one of the run's secrets is replaced by its name.
    expect(stored.requirement).toBe("Log in with password [secret: login_password] and check the account page.");
    expect(stored.testData).toEqual({ email: "qa@demo.test", password: "[REDACTED]", note: "pw is hunter2-long-secret" });
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

describe("POST /v1/test-runs: the run's model (request → Settings → environment)", () => {
  /** LLM_PROVIDER=anthropic with ANTHROPIC_API_KEY set, no Gemini key. */
  const ANTHROPIC_ENV: ApiLlmConfig = {
    envChoice: { provider: "anthropic", model: "claude-sonnet-5", reasoning: "default" },
    envKeys: { anthropic: true, gemini: false, deepseek: false },
    fakeAllowed: true,
  };
  const saveGeminiKey = () =>
    new ProviderKeyRepository(t.tdb.db).set(TEST_TENANT_ID, "gemini", encryptProviderKey("AIza-Test-Key", { tenantId: TEST_TENANT_ID, provider: "gemini" }, SECRETS_KEY));
  const saveDefaults = (model: string, reasoning: "default" | "low" | "medium" | "high") =>
    new LlmSettingsRepository(t.tdb.db).upsertDefaults(TEST_TENANT_ID, { model, reasoning });
  const storedLlm = async (res: { json(): { runId: string } }) => (await new RunRepository(t.tdb.db).findById(res.json().runId))!.request.llm;
  const active = () => new RunRepository(t.tdb.db).countActive(TEST_TENANT_ID);

  beforeEach(async () => {
    t.deps.config.llm = ANTHROPIC_ENV;
    await t.tdb.db.delete(schema.llmProviderKeys);
    await t.tdb.db.delete(schema.llmSettings);
  });

  it("nothing saved, nothing requested: the environment's choice is recorded", async () => {
    const res = await post(validBody());
    expect(res.statusCode).toBe(202);
    expect(await storedLlm(res)).toEqual({ provider: "anthropic", model: "claude-sonnet-5", reasoning: "default" });
  });

  it("the saved defaults win over the environment; the request's reasoning alone overrides their level", async () => {
    await saveDefaults("claude-opus-5-5", "medium");
    expect(await storedLlm(await post(validBody()))).toEqual({ provider: "anthropic", model: "claude-opus-5-5", reasoning: "medium" });
    expect(await storedLlm(await post(validBody({ llm: { reasoning: "high" } })))).toEqual({ provider: "anthropic", model: "claude-opus-5-5", reasoning: "high" });
  });

  it("the request's model wins over Settings (its provider's key saved in Settings), its level defaulting to default", async () => {
    await saveDefaults("claude-opus-5-5", "medium");
    await saveGeminiKey();
    expect(await storedLlm(await post(validBody({ llm: { model: "gemini-3.8-flash", reasoning: "low" } })))).toEqual({
      provider: "gemini",
      model: "gemini-3.8-flash",
      reasoning: "low",
    });
    expect(await storedLlm(await post(validBody({ llm: { model: "claude-haiku-4-5" } })))).toEqual({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      reasoning: "default",
    });
  });

  it.each([
    ["a model whose provider has no key", { model: "gemini-3.8-flash" }, ["llm", "model"], "Add a Google Gemini API key in Settings"],
    ["an unknown model", { model: "gpt-x" }, ["llm", "model"], "not a model offered here"],
    ["a level the model does not take", { model: "claude-haiku-4-5", reasoning: "high" }, ["llm", "reasoning"], "not high"],
  ])("refuses %s: 422 MODEL_NOT_AVAILABLE on the field, no run created", async (_what, llm, path, message) => {
    const before = await active();
    const res = await post(validBody({ llm }));
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: "MODEL_NOT_AVAILABLE", issues: [{ path, message: expect.stringContaining(message) }] });
    expect(await active()).toBe(before);
  });

  it("defaults whose provider has no key → 422 at [\"llm\"], naming the fix; also after the key behind saved defaults is removed", async () => {
    t.deps.config.llm = { ...ANTHROPIC_ENV, envKeys: { anthropic: false, gemini: false, deepseek: false } };
    const env = await post(validBody());
    expect(env.statusCode).toBe(422);
    expect(env.json()).toMatchObject({ code: "MODEL_NOT_AVAILABLE", message: expect.stringContaining("Add an Anthropic API key in Settings"), issues: [{ path: ["llm"] }] });

    t.deps.config.llm = ANTHROPIC_ENV;
    await saveGeminiKey();
    await saveDefaults("gemini-3.8-flash", "low");
    expect((await post(validBody())).statusCode).toBe(202);
    await new ProviderKeyRepository(t.tdb.db).remove(TEST_TENANT_ID, "gemini");
    expect((await post(validBody())).json()).toMatchObject({ code: "MODEL_NOT_AVAILABLE", issues: [{ path: ["llm"], message: expect.stringContaining("Add a Google Gemini API key in Settings") }] });
  });

  it("the fake engine is refused in production", async () => {
    t.deps.config.llm = { ...ANTHROPIC_ENV, fakeAllowed: false };
    expect((await post(validBody({ llm: { model: "fake" } }))).statusCode).toBe(422);
    t.deps.config.llm = ANTHROPIC_ENV;
    expect(await storedLlm(await post(validBody({ llm: { model: "fake" } })))).toEqual({ provider: "fake", model: "fake", reasoning: "default" });
  });

  it("a retry with the same Idempotency-Key replays the original run even after Settings changed; the hash covers the override", async () => {
    await saveGeminiKey();
    const body = validBody({ llm: { model: "gemini-3.8-flash" } });
    const first = await post(body, { "idempotency-key": "llm-retry-1" });
    expect(first.statusCode).toBe(202);
    await new ProviderKeyRepository(t.tdb.db).remove(TEST_TENANT_ID, "gemini");
    const retry = await post(body, { "idempotency-key": "llm-retry-1" });
    expect(retry.statusCode).toBe(202);
    expect(retry.json().runId).toBe(first.json().runId);
    expect((await post(validBody({ llm: { model: "claude-sonnet-5" } }), { "idempotency-key": "llm-retry-1" })).statusCode).toBe(409);
    expect((await post(body, { "idempotency-key": "llm-retry-2" })).statusCode).toBe(422);
  });

  it("the summary names the run's model with its catalog label; a run created before model choice has none", async () => {
    const res = await post(validBody({ llm: { model: "claude-opus-5-5", reasoning: "medium" } }));
    const { runId } = res.json();
    const summary = TestRunSummarySchema.parse((await t.app.inject({ method: "GET", url: `/v1/test-runs/${runId}`, headers: auth })).json());
    expect(summary.llm).toEqual({ provider: "anthropic", model: "claude-opus-5-5", label: "Claude Opus 5.5", reasoning: "medium" });
    const list = (await t.app.inject({ method: "GET", url: "/v1/test-runs?limit=100", headers: auth })).json();
    expect(list.items.find((i: { runId: string }) => i.runId === runId).llm.label).toBe("Claude Opus 5.5");

    const { llm: _none, ...older } = (await new RunRepository(t.tdb.db).findById(runId))!.request;
    const old = await new RunRepository(t.tdb.db).create({ tenantId: TEST_TENANT_ID, targetUrl: "https://shop.example.com", request: older });
    expect((await t.app.inject({ method: "GET", url: `/v1/test-runs/${old.id}`, headers: auth })).json().llm).toBeNull();
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
  it("cancels an AWAITING_SELECTION run immediately (no worker holds it) and purges its secrets", async () => {
    const { runId } = (await post(validBody({ requirement: "", secrets: { password: "pw-123456" } }))).json();
    const runs = new RunRepository(t.tdb.db);
    await runs.transition(runId, "QUEUED", "SURVEYING");
    await runs.transition(runId, "SURVEYING", "AWAITING_SELECTION");
    const res = await t.app.inject({ method: "POST", url: `/v1/test-runs/${runId}/cancel`, headers: auth });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ lifecycle: "CANCELLED", cancelReason: "USER_REQUESTED" });
    expect(await new SecretRepository(t.tdb.db).listActive(runId)).toHaveLength(0);
    const events = await new EventRepository(t.tdb.db).listAfter(runId, 0, 10);
    expect(events.map((e) => e.type)).toEqual(["run.created", "run.cancelled"]);
  });

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
