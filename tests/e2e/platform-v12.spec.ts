import { VALID_EMAIL, VALID_PASSWORD } from "@platform/demo-shop";
import { afterAll, describe, expect, inject, it } from "vitest";
import { createClient, runSuiteAndWait } from "../../integrations/platform-client/client.mjs";
import { api, db } from "./support/client";
import { REQUIREMENTS } from "./support/scenarios";

const stack = inject("e2e");
/** A test that waits for several live runs in turn (about a minute each on a real model) gets 7 minutes (KI-001). */
const LIVE_MULTI_RUN_TIMEOUT = stack.mode === "live" ? 420_000 : undefined;

async function signIn(email: string, password: string) {
  const res = await service.call("POST", "/v1/auth/login", { email, password });
  if (res.status !== 200) throw new Error(`login → ${res.status} ${res.text}`);
  return api(stack, res.json.token as string);
}
const service = api(stack);
const store = db(stack);
afterAll(() => store.close());

/** Polls a suite run until it has settled. */
async function suiteRunSettled(suiteRunId: string, timeoutMs = 150_000) {
  const deadline = Date.now() + timeoutMs;
  let last: any;
  while (Date.now() < deadline) {
    last = (await service.call("GET", `/v1/suite-runs/${suiteRunId}`)).json;
    if (last?.status === "COMPLETED") return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for suite run ${suiteRunId}; last ${JSON.stringify(last)}`);
}

/** A finished, passing run with a saved Playwright test. */
async function passingRun(body: Record<string, unknown>) {
  const runId = await service.create({ targetUrl: `${stack.targetUrl}/`, options: { autoConfirmCriteria: true }, ...body });
  expect(await service.finished(runId)).toMatchObject({ lifecycle: "COMPLETED", verdict: "PASSED" });
  return runId;
}

describe("V1.2 F1 — suites", () => {
  it("runs two saved tests together, each as its own rerun with no model call, and settles the suite run PASSED", async () => {
    const cart = await passingRun({ requirement: REQUIREMENTS.cart });
    const account = await passingRun({ requirement: REQUIREMENTS.account, testData: { email: VALID_EMAIL }, secrets: { password: VALID_PASSWORD } });
    const profile = await service.call("POST", "/v1/credential-profiles", { name: "Suite shop account", secrets: { password: VALID_PASSWORD } });
    const suite = await service.call("POST", "/v1/suites", { name: "Shop smoke", credentialProfileId: profile.json.id });
    expect(suite.status).toBe(201);
    for (const sourceRunId of [cart, account]) {
      expect((await service.call("POST", `/v1/suites/${suite.json.id}/entries`, { sourceRunId })).status).toBe(201);
    }

    const started = await service.call("POST", `/v1/suites/${suite.json.id}/runs`, {});
    expect(started.status).toBe(202);
    const settled = await suiteRunSettled(started.json.suiteRunId);
    expect(settled).toMatchObject({ status: "COMPLETED", verdict: "PASSED", counts: { total: 2, passed: 2 } });
    expect(settled.children.map((c: { sourceRunId: string }) => c.sourceRunId)).toEqual([cart, account]);
    for (const runId of started.json.runIds as string[]) {
      expect(await service.get(runId)).toMatchObject({ kind: "rerun", suiteRunId: started.json.suiteRunId, verdict: "PASSED" });
      expect(await store.llmCalls(runId)).toEqual([]);
      expect(await store.secretsActive(runId)).toEqual([]);
    }
  }, LIVE_MULTI_RUN_TIMEOUT);
});

describe("V1.2 F2 — compare with the previous run", () => {
  it("a rerun is compared with its test's previous run; a broken cart regresses against a chosen passing run", async () => {
    const passing = await passingRun({ requirement: REQUIREMENTS.cart });
    const rerun = await service.call("POST", `/v1/test-runs/${passing}/rerun`, {});
    expect(await service.finished(rerun.json.runId)).toMatchObject({ verdict: "PASSED" });
    const same = await service.call("GET", `/v1/test-runs/${rerun.json.runId}/comparison`);
    expect(same.json).toMatchObject({ baseline: { runId: passing }, verdict: { before: "PASSED", after: "PASSED" }, counts: { regressed: 0 } });

    const broken = await service.create({
      targetUrl: `${stack.targetUrl}/?bug=empty_cart`,
      requirement: REQUIREMENTS.cart,
      options: { autoConfirmCriteria: true },
    });
    expect(await service.finished(broken)).toMatchObject({ verdict: "FAILED" });
    const compared = await service.call("GET", `/v1/test-runs/${broken}/comparison?baseline=${passing}`);
    expect(compared.json).toMatchObject({ chosenBaseline: true, verdict: { before: "PASSED", after: "FAILED" } });
    if (stack.mode === "ci") {
      // The same scripted wording: the cart check is matched with the passing run's and regresses.
      expect(compared.json.counts.regressed).toBeGreaterThan(0);
    } else {
      // A real model words a fresh analysis of the requirement its own way, and criteria are matched by wording; the
      // failing check is listed either way.
      const failing = (compared.json.criteria as { after: string | null; change: string }[]).filter((c) => c.after === "FAIL");
      expect(failing.length).toBeGreaterThan(0);
      for (const c of failing) expect(["regressed", "added", "changed"]).toContain(c.change);
    }
    const md = await fetch(`${stack.apiUrl}/v1/test-runs/${rerun.json.runId}/report.md`, { headers: { authorization: `Bearer ${stack.apiToken}` } });
    expect(await md.text()).toContain("## Compared with the previous run");
  }, LIVE_MULTI_RUN_TIMEOUT);
});

describe("V1.2 F3 — scheduled suite runs", () => {
  it("a schedule fires on its own and runs the suite as its creator", async () => {
    const admin = await signIn(stack.admin.email, stack.admin.password);
    const cart = await passingRun({ requirement: REQUIREMENTS.cart });
    const suite = (await admin.call("POST", "/v1/suites", { name: "Every minute" })).json;
    expect((await admin.call("POST", `/v1/suites/${suite.id}/entries`, { sourceRunId: cart })).status).toBe(201);
    const schedule = await admin.call("POST", `/v1/suites/${suite.id}/schedules`, { cron: "* * * * *", timezone: "UTC" });
    expect(schedule.status).toBe(201);

    const deadline = Date.now() + 90_000;
    let fired: { lastOutcome: string | null; lastSuiteRunId: string | null } | undefined;
    while (Date.now() < deadline) {
      fired = (await admin.call("GET", `/v1/suites/${suite.id}/schedules`)).json.items[0];
      if (fired?.lastOutcome) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    // Stop it before asserting, so a failed assertion leaves nothing firing.
    await admin.call("DELETE", `/v1/suite-schedules/${schedule.json.id}`);
    expect(fired).toMatchObject({ lastOutcome: "started" });
    const settled = await suiteRunSettled(fired!.lastSuiteRunId!);
    expect(settled).toMatchObject({ trigger: "schedule", verdict: "PASSED", owner: { name: expect.any(String) } });
  }, LIVE_MULTI_RUN_TIMEOUT ?? 180_000);
});

describe("V1.2 F4 — API tokens", () => {
  it("a token runs its user's suite and reads the result, and gets 403 TOKEN_SCOPE anywhere else", async () => {
    const admin = await signIn(stack.admin.email, stack.admin.password);
    const cart = await passingRun({ requirement: REQUIREMENTS.cart });
    const suite = (await admin.call("POST", "/v1/suites", { name: "Token smoke" })).json;
    await admin.call("POST", `/v1/suites/${suite.id}/entries`, { sourceRunId: cart });
    const created = await admin.call("POST", "/v1/api-tokens", { name: "E2E pipeline", scopes: ["suites:run", "results:read"] });
    expect(created.status).toBe(201);
    const withToken = async (method: string, url: string, body?: unknown) => {
      const res = await fetch(`${stack.apiUrl}${url}`, {
        method,
        headers: {
          authorization: `Bearer ${stack.apiToken}`,
          "x-api-token": created.json.token,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, json: (await res.json()) as any };
    };

    const byName = await withToken("GET", `/v1/suites?name=${encodeURIComponent("token smoke")}`);
    expect(byName.json.items.map((s: { id: string }) => s.id)).toEqual([suite.id]);
    const started = await withToken("POST", `/v1/suites/${suite.id}/runs`, {});
    expect(started.status).toBe(202);
    const settled = await suiteRunSettled(started.json.suiteRunId);
    expect(settled).toMatchObject({ trigger: "api", verdict: "PASSED" });
    expect((await withToken("GET", `/v1/suite-runs/${started.json.suiteRunId}`)).json.status).toBe("COMPLETED");

    expect((await withToken("POST", "/v1/test-runs", { targetUrl: `${stack.targetUrl}/`, requirement: REQUIREMENTS.cart })).json.code).toBe("TOKEN_SCOPE");
    expect((await withToken("GET", "/v1/api-tokens")).json.code).toBe("TOKEN_SCOPE");
    await admin.call("DELETE", `/v1/api-tokens/${created.json.id}`);
    expect((await withToken("GET", "/v1/suites")).json.code).toBe("TOKEN_INVALID");
  }, LIVE_MULTI_RUN_TIMEOUT);
});

describe("V1.2 F5 — CI: the client, the action's core, JUnit", () => {
  it("runs a suite by name with a token, waits for it and gets its JUnit XML", async () => {
    const admin = await signIn(stack.admin.email, stack.admin.password);
    const cart = await passingRun({ requirement: REQUIREMENTS.cart });
    const suite = (await admin.call("POST", "/v1/suites", { name: "CI smoke" })).json;
    await admin.call("POST", `/v1/suites/${suite.id}/entries`, { sourceRunId: cart });
    const { token } = (await admin.call("POST", "/v1/api-tokens", { name: "CI", scopes: ["suites:run", "results:read"] })).json;

    // What the web app's /api/ext path does (lib/ext-proxy.ts, tested on its own): the token as X-Api-Token.
    const web = "https://tests.example.com";
    const viaExt: typeof fetch = async (input, init = {}) => {
      const url = String(input).replace(`${web}/api/ext`, stack.apiUrl);
      const headers = new Headers(init.headers);
      headers.set("x-api-token", headers.get("authorization")!.replace(/^Bearer /, ""));
      headers.set("authorization", `Bearer ${stack.apiToken}`);
      return fetch(url, { ...init, headers });
    };
    const files = new Map<string, string>();
    const result = await runSuiteAndWait({
      client: createClient({ url: web, token, fetch: viaExt }),
      suite: "ci SMOKE",
      intervalMs: 500,
      junitPath: "junit.xml",
      writeFile: async (p, t) => void files.set(p, t),
      context: { repository: "acme/shop", sha: "abc123", runUrl: "https://github.com/acme/shop/actions/runs/1" },
    });
    expect(result).toMatchObject({ exitCode: 0, verdict: "PASSED", url: `${web}/suite-runs/${result.suiteRunId}` });
    expect(files.get("junit.xml")).toMatch(/<testsuites name="CI smoke" id="srn_[^"]+" tests="\d+" failures="0"/);
    expect((await admin.call("GET", `/v1/suite-runs/${result.suiteRunId}`)).json).toMatchObject({
      trigger: "api",
      ci: { repository: "acme/shop", sha: "abc123" },
      startedWithToken: { name: "CI" },
    });
  }, LIVE_MULTI_RUN_TIMEOUT);
});
