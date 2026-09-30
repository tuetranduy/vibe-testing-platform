import { describe, expect, it, vi } from "vitest";
import { main } from "../../.github/actions/run-suite/index.mjs";
import { cli, parseArgs } from "./cli.mjs";
import { PlatformError, createClient, parseFailOn, runSuiteAndWait, summaryMarkdown, waitForSuiteRun, type SuiteRun } from "./client.mjs";

const URL_ = "https://tests.example.com";
const TOKEN = `tap_${"k".repeat(43)}`;

const suiteRun = (patch: Partial<SuiteRun> = {}): SuiteRun => ({
  id: "srn_1",
  suiteId: "ste_1",
  suiteName: "Checkout smoke",
  trigger: "api",
  status: "COMPLETED",
  verdict: "PASSED",
  createdAt: "2026-09-30T10:00:00.000Z",
  finishedAt: "2026-09-30T10:02:00.000Z",
  counts: { total: 2, active: 0, passed: 2, failed: 0, blocked: 0, inconclusive: 0, noVerdict: 0 },
  changes: { regressed: 0, fixed: 0 },
  children: [
    { runId: "run_a", sourceRunId: "run_s", title: "Add to cart | fast", targetUrl: "https://shop.example.com/", lifecycle: "COMPLETED", verdict: "PASSED", finishedAt: null, change: "unchanged" },
    { runId: "run_b", sourceRunId: "run_t", title: "Checkout", targetUrl: "https://shop.example.com/", lifecycle: "COMPLETED", verdict: "PASSED", finishedAt: null, change: "new" },
  ],
  ...patch,
});

type Route = (init: RequestInit) => Response;
/** A fake platform: `"METHOD /path"` → answer (each call takes the next answer of a list). */
function platform(routes: Record<string, Route | Route[]>) {
  const calls: { key: string; init: RequestInit }[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const key = `${init.method ?? "GET"} ${String(input).replace(`${URL_}/api/ext`, "")}`;
    calls.push({ key, init });
    const route = routes[key];
    if (!route) throw new Error(`unexpected ${key}`);
    const next = Array.isArray(route) ? (route.length > 1 ? route.shift()! : route[0]!) : route;
    return next(init);
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const noSleep = async () => {};

const happy = (extra: Record<string, Route | Route[]> = {}) =>
  platform({
    "GET /v1/suites?name=checkout%20smoke": () => json(200, { items: [{ id: "ste_1", name: "Checkout smoke" }] }),
    "POST /v1/suites/ste_1/runs": () => json(202, { suiteRunId: "srn_1", runIds: ["run_a", "run_b"] }),
    "GET /v1/suite-runs/srn_1": [() => json(200, suiteRun({ status: "RUNNING", verdict: null, counts: { ...suiteRun().counts, active: 1, passed: 1 } })), () => json(200, suiteRun())],
    "GET /v1/suite-runs/srn_1/junit.xml": () => new Response("<testsuites/>", { status: 200, headers: { "content-type": "application/xml" } }),
    ...extra,
  });

describe("createClient", () => {
  it("sends the token as a bearer to /api/ext and finds a suite by name, or takes an id as is", async () => {
    const p = happy();
    const client = createClient({ url: `${URL_}/`, token: TOKEN, fetch: p.fetch });
    expect(await client.findSuite("checkout smoke")).toEqual({ id: "ste_1", name: "Checkout smoke" });
    expect((p.calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(await client.findSuite("ste_abc")).toEqual({ id: "ste_abc", name: "ste_abc" });
    expect(p.calls).toHaveLength(1);
    expect(client.suiteRunUrl("srn_1")).toBe(`${URL_}/suite-runs/srn_1`);
  });

  it("turns error answers into PlatformError with the API's code, and refuses a bad URL or token", async () => {
    const p = platform({ "GET /v1/suites?name=x": () => json(403, { code: "TOKEN_SCOPE", message: "This API token may not do this" }) });
    const client = createClient({ url: URL_, token: TOKEN, fetch: p.fetch });
    await expect(client.findSuite("x")).rejects.toMatchObject({ status: 403, code: "TOKEN_SCOPE" });
    expect(() => createClient({ url: "tests.example.com", token: TOKEN })).toThrow(/https/);
    expect(() => createClient({ url: URL_, token: "secret" })).toThrow(/tap_/);
  });
});

describe("waitForSuiteRun", () => {
  it("polls until COMPLETED, retrying rate limits and server errors with a growing pause", async () => {
    const p = platform({
      "GET /v1/suite-runs/srn_1": [
        () => json(429, { code: "TOO_MANY_REQUESTS", message: "slow down" }, { "retry-after": "7" }),
        () => json(502, { code: "UPSTREAM_UNAVAILABLE", message: "down" }),
        () => json(200, suiteRun({ status: "RUNNING", verdict: null })),
        () => json(200, suiteRun()),
      ],
    });
    const pauses: number[] = [];
    const run = await waitForSuiteRun(createClient({ url: URL_, token: TOKEN, fetch: p.fetch }), "srn_1", {
      intervalMs: 1000,
      sleep: async (ms) => void pauses.push(ms),
    });
    expect(run.verdict).toBe("PASSED");
    // Retry-After when the answer has one; else doubling with each failure in a row; the normal interval after.
    expect(pauses).toEqual([7000, 4000, 1000]);
  });

  it("gives up at the timeout, and at once on an error that retrying won't fix", async () => {
    let clock = 0;
    const running = platform({ "GET /v1/suite-runs/srn_1": () => json(200, suiteRun({ status: "RUNNING", verdict: null })) });
    await expect(
      waitForSuiteRun(createClient({ url: URL_, token: TOKEN, fetch: running.fetch }), "srn_1", {
        timeoutMs: 25_000,
        intervalMs: 10_000,
        now: () => clock,
        sleep: async (ms) => void (clock += ms),
      }),
    ).rejects.toMatchObject({ name: "WaitTimeoutError", last: { status: "RUNNING" } });
    const gone = platform({ "GET /v1/suite-runs/srn_1": () => json(404, { code: "NOT_FOUND", message: "Not found" }) });
    await expect(waitForSuiteRun(createClient({ url: URL_, token: TOKEN, fetch: gone.fetch }), "srn_1", { sleep: noSleep })).rejects.toBeInstanceOf(PlatformError);
  });
});

describe("summaryMarkdown", () => {
  it("leads with the verdict and links every test, escaping titles", () => {
    const text = summaryMarkdown(suiteRun({ verdict: "FAILED", changes: { regressed: 1, fixed: 0 } }), `${URL_}/`);
    expect(text.startsWith("## ❌ Failed: suite “Checkout smoke”\n")).toBe(true);
    expect(text).toContain(`[Open the suite run](${URL_}/suite-runs/srn_1) · 2 tests: 2 passed`);
    expect(text).toContain("Since their previous run: 1 regressed, 0 fixed.");
    expect(text).toContain(`| [Add to cart \\| fast](${URL_}/runs/run_a) | ✅ Passed | Unchanged |`);
    expect(text).toContain("| First run |");
  });
});

describe("runSuiteAndWait", () => {
  it("starts, waits, writes the JUnit file and exits 0 on a pass; 1 when the verdict is in failOn", async () => {
    const files = new Map<string, string>();
    const writeFile = async (p: string, t: string) => void files.set(p, t);
    const ok = await runSuiteAndWait({ client: createClient({ url: URL_, token: TOKEN, fetch: happy().fetch }), suite: "checkout smoke", junitPath: "out.xml", writeFile, sleep: noSleep });
    expect(ok).toMatchObject({ exitCode: 0, suiteRunId: "srn_1", verdict: "PASSED", url: `${URL_}/suite-runs/srn_1` });
    expect(files.get("out.xml")).toBe("<testsuites/>");

    const failing = happy({ "GET /v1/suite-runs/srn_1": () => json(200, suiteRun({ verdict: "INCONCLUSIVE" })) });
    const client = createClient({ url: URL_, token: TOKEN, fetch: failing.fetch });
    expect((await runSuiteAndWait({ client, suite: "checkout smoke", sleep: noSleep })).exitCode).toBe(0);
    expect((await runSuiteAndWait({ client, suite: "checkout smoke", sleep: noSleep, failOn: ["FAILED", "INCONCLUSIVE"] })).exitCode).toBe(1);
  });

  it("exits 2 on a platform error, 3 on a timeout, 0 without waiting", async () => {
    const missing = platform({ "GET /v1/suites?name=nope": () => json(200, { items: [] }) });
    expect(await runSuiteAndWait({ client: createClient({ url: URL_, token: TOKEN, fetch: missing.fetch }), suite: "nope" })).toMatchObject({
      exitCode: 2,
      message: expect.stringContaining("SUITE_NOT_FOUND"),
    });
    const slow = happy({ "GET /v1/suite-runs/srn_1": () => json(200, suiteRun({ status: "RUNNING", verdict: null })) });
    const timedOut = await runSuiteAndWait({ client: createClient({ url: URL_, token: TOKEN, fetch: slow.fetch }), suite: "checkout smoke", timeoutMs: 1, sleep: noSleep });
    expect(timedOut).toMatchObject({ exitCode: 3, suiteRunId: "srn_1" });
    const started = await runSuiteAndWait({ client: createClient({ url: URL_, token: TOKEN, fetch: happy().fetch }), suite: "checkout smoke", wait: false });
    expect(started).toMatchObject({ exitCode: 0, verdict: null, suiteRunId: "srn_1" });
  });

  it("parses fail-on lists", () => {
    expect(parseFailOn("failed, blocked")).toEqual(["FAILED", "BLOCKED"]);
    expect(() => parseFailOn("FAILED,BROKEN")).toThrow(/BROKEN/);
  });
});

describe("cli", () => {
  it("parses flags", () => {
    expect(parseArgs(["run-suite", "--url", URL_, "--suite=Smoke tests", "--no-wait", "--junit", "x.xml"])).toEqual({
      command: "run-suite",
      flags: { url: URL_, suite: "Smoke tests", wait: false, junit: "x.xml" },
    });
  });

  it("runs a suite with the token from PLATFORM_API_TOKEN and returns the exit code", async () => {
    const lines: string[] = [];
    const code = await cli(["run-suite", "--url", URL_, "--suite", "checkout smoke"], { PLATFORM_API_TOKEN: TOKEN }, {
      fetch: happy().fetch,
      out: (l) => lines.push(l),
      err: (l) => lines.push(`ERR ${l}`),
      sleep: noSleep,
    });
    expect(code).toBe(0);
    expect(lines.at(-1)).toBe("Suite “Checkout smoke”: Passed");
    expect(await cli(["run-suite", "--suite", "x"], {}, { err: () => {} })).toBe(2);
    expect(await cli(["run-suite", "--url", URL_, "--suite", "x"], {}, { err: () => {} })).toBe(2);
  });
});

describe("the GitHub Action", () => {
  const env = (extra: Record<string, string> = {}) => ({
    "INPUT_PLATFORM-URL": URL_,
    "INPUT_API-TOKEN": TOKEN,
    INPUT_SUITE: "checkout smoke",
    INPUT_WAIT: "true",
    "INPUT_TIMEOUT-MINUTES": "30",
    "INPUT_FAIL-ON": "FAILED",
    "INPUT_JUNIT-PATH": "reports/junit.xml",
    GITHUB_OUTPUT: "/out",
    GITHUB_STEP_SUMMARY: "/summary",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REPOSITORY: "acme/shop",
    GITHUB_RUN_ID: "42",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: "abc123",
    ...extra,
  });

  it("masks the token, sends the CI context, and writes outputs, the summary and the JUnit file", async () => {
    const p = happy();
    const files = new Map<string, string>();
    const lines: string[] = [];
    const code = await main(env(), {
      fetch: p.fetch,
      log: (l) => lines.push(l),
      sleep: noSleep,
      appendFile: async (f, t) => void files.set(f, (files.get(f) ?? "") + t),
      writeFile: async (f, t) => void files.set(f, t),
    });
    expect(code).toBe(0);
    expect(lines[0]).toBe(`::add-mask::${TOKEN}`);
    const start = p.calls.find((c) => c.key === "POST /v1/suites/ste_1/runs")!;
    expect(JSON.parse(String(start.init.body))).toEqual({
      context: { repository: "acme/shop", ref: "refs/heads/main", sha: "abc123", runUrl: "https://github.com/acme/shop/actions/runs/42" },
    });
    expect((start.init.headers as Record<string, string>)["idempotency-key"]).toMatch(/^gh-42-1-/);
    expect(files.get("/out")).toBe(`suite-run-id=srn_1\nverdict=PASSED\nurl=${URL_}/suite-runs/srn_1\n`);
    expect(files.get("/summary")).toContain("## ✅ Passed: suite “Checkout smoke”");
    expect(files.get("reports/junit.xml")).toBe("<testsuites/>");
    // Only the mask command itself names the token.
    expect(lines.slice(1).join("\n")).not.toContain(TOKEN.slice(10));
  });

  it("fails the step with an error annotation on a failing verdict or a bad input", async () => {
    const failing = happy({ "GET /v1/suite-runs/srn_1": () => json(200, suiteRun({ verdict: "FAILED" })) });
    const lines: string[] = [];
    const io = { log: (l: string) => lines.push(l), sleep: noSleep, appendFile: async () => {}, writeFile: async () => {} };
    expect(await main(env(), { ...io, fetch: failing.fetch })).toBe(1);
    expect(lines.at(-1)).toBe("::error::Suite “Checkout smoke”: Failed");
    expect(await main(env({ "INPUT_API-TOKEN": "" }), { ...io, fetch: failing.fetch })).toBe(1);
    expect(lines.at(-1)).toMatch(/^::error::The API token must look like tap_/);
    expect(await main(env({ "INPUT_FAIL-ON": "SOMETIMES" }), { ...io, fetch: failing.fetch })).toBe(1);
  });
});
