// @ts-check
/**
 * The AI testing platform's client for CI and scripts (V1.2 F5). No dependencies (Node 20+: global fetch).
 * Everything goes through the web app's `/api/ext/v1/...` path with an API token (`tap_...`): find a suite, run
 * it, wait for the result, fetch its JUnit XML and summarise it in Markdown.
 */

/**
 * @typedef {"PASSED" | "FAILED" | "BLOCKED" | "INCONCLUSIVE"} Verdict
 * @typedef {{ repository?: string; ref?: string; sha?: string; runUrl?: string }} CiContext
 * @typedef {{
 *   runId: string; sourceRunId: string; title: string; targetUrl: string; lifecycle: string;
 *   verdict: Verdict | null; finishedAt: string | null;
 *   change: "regressed" | "fixed" | "changed" | "unchanged" | "new" | null;
 * }} SuiteRunChild
 * @typedef {{
 *   id: string; suiteId: string; suiteName: string; trigger: string; status: "RUNNING" | "COMPLETED";
 *   verdict: Verdict | null; createdAt: string; finishedAt: string | null;
 *   counts: { total: number; active: number; passed: number; failed: number; blocked: number; inconclusive: number; noVerdict: number };
 *   changes?: { regressed: number; fixed: number };
 *   children: SuiteRunChild[];
 * }} SuiteRun
 */

export const VERDICTS = /** @type {const} */ (["PASSED", "FAILED", "BLOCKED", "INCONCLUSIVE"]);

/** An error answer from the platform (or the web app in front of it). */
export class PlatformError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   * @param {number | null} [retryAfterSeconds]
   */
  constructor(status, code, message, retryAfterSeconds = null) {
    super(message);
    this.name = "PlatformError";
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** The wait ran out before the suite run finished. */
export class WaitTimeoutError extends Error {
  /** @param {SuiteRun | null} last */
  constructor(last) {
    super("Timed out waiting for the suite run to finish");
    this.name = "WaitTimeoutError";
    this.last = last;
  }
}

/**
 * @param {{ url: string; token: string; fetch?: typeof globalThis.fetch }} options
 */
export function createClient({ url, token, fetch: f = globalThis.fetch }) {
  if (!/^https?:\/\//.test(url)) throw new Error("The platform URL must start with https:// (or http:// for a local one)");
  if (!/^tap_[A-Za-z0-9_-]{20,100}$/.test(token)) throw new Error("The API token must look like tap_…");
  const webUrl = url.replace(/\/+$/, "");
  const base = `${webUrl}/api/ext`;

  /**
   * @param {"GET" | "POST"} method
   * @param {string} path
   * @param {{ body?: unknown; accept?: string; headers?: Record<string, string> }} [opts]
   */
  async function call(method, path, opts = {}) {
    /** @type {Record<string, string>} */
    const headers = { authorization: `Bearer ${token}`, accept: opts.accept ?? "application/json", ...opts.headers };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const res = await f(`${base}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    if (!res.ok) {
      let code = `HTTP_${res.status}`;
      let message = `The platform answered ${res.status}`;
      try {
        const err = JSON.parse(text);
        if (typeof err.code === "string") code = err.code;
        if (typeof err.message === "string") message = err.message;
      } catch {
        // not JSON
      }
      const retry = Number.parseInt(res.headers.get("retry-after") ?? "", 10);
      throw new PlatformError(res.status, code, message, Number.isFinite(retry) ? retry : null);
    }
    return opts.accept && opts.accept !== "application/json" ? text : JSON.parse(text);
  }

  return {
    webUrl,
    /**
     * A suite by id (`ste_…`) or by name (exact, case-insensitive).
     * @param {string} nameOrId
     * @returns {Promise<{ id: string; name: string }>}
     */
    async findSuite(nameOrId) {
      const wanted = nameOrId.trim();
      if (/^ste_[A-Za-z0-9_-]+$/.test(wanted)) return { id: wanted, name: wanted };
      const { items } = await call("GET", `/v1/suites?name=${encodeURIComponent(wanted)}`);
      const suite = items?.[0];
      if (!suite) throw new PlatformError(404, "SUITE_NOT_FOUND", `No suite named “${wanted}” that this token's user can see`);
      return { id: suite.id, name: suite.name };
    },
    /**
     * @param {string} suiteId
     * @param {{ context?: CiContext; idempotencyKey?: string }} [opts]
     * @returns {Promise<{ suiteRunId: string; runIds: string[] }>}
     */
    runSuite(suiteId, opts = {}) {
      return call("POST", `/v1/suites/${encodeURIComponent(suiteId)}/runs`, {
        body: opts.context ? { context: opts.context } : {},
        ...(opts.idempotencyKey ? { headers: { "idempotency-key": opts.idempotencyKey } } : {}),
      });
    },
    /** @param {string} suiteRunId @returns {Promise<SuiteRun>} */
    getSuiteRun: (suiteRunId) => call("GET", `/v1/suite-runs/${encodeURIComponent(suiteRunId)}`),
    /** @param {string} suiteRunId @returns {Promise<SuiteRun>} */
    cancelSuiteRun: (suiteRunId) => call("POST", `/v1/suite-runs/${encodeURIComponent(suiteRunId)}/cancel`),
    /** @param {string} suiteRunId @returns {Promise<string>} */
    junit: (suiteRunId) => call("GET", `/v1/suite-runs/${encodeURIComponent(suiteRunId)}/junit.xml`, { accept: "application/xml" }),
    /** @param {string} suiteRunId */
    suiteRunUrl: (suiteRunId) => `${webUrl}/suite-runs/${encodeURIComponent(suiteRunId)}`,
  };
}

/** @typedef {ReturnType<typeof createClient>} PlatformClient */

const sleepFor = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Polls a suite run until it has finished. Rate limits (429), server errors and network failures are retried with
 * a growing pause (the answer's Retry-After when it has one); anything else is thrown.
 * @param {PlatformClient} client
 * @param {string} suiteRunId
 * @param {{ timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number; onProgress?: (run: SuiteRun) => void }} [opts]
 * @returns {Promise<SuiteRun>}
 */
export async function waitForSuiteRun(client, suiteRunId, opts = {}) {
  const { timeoutMs = 30 * 60_000, intervalMs = 10_000, sleep = sleepFor, now = Date.now, onProgress } = opts;
  const deadline = now() + timeoutMs;
  /** @type {SuiteRun | null} */
  let last = null;
  let failures = 0;
  for (;;) {
    let pause = intervalMs;
    try {
      last = await client.getSuiteRun(suiteRunId);
      failures = 0;
      onProgress?.(last);
      if (last.status === "COMPLETED") return last;
    } catch (err) {
      const retryable = err instanceof PlatformError ? err.status === 429 || err.status >= 500 : err instanceof TypeError;
      if (!retryable || failures >= 8) throw err;
      failures += 1;
      pause = err instanceof PlatformError && err.retryAfterSeconds ? err.retryAfterSeconds * 1000 : Math.min(intervalMs * 2 ** failures, 120_000);
    }
    if (now() + pause > deadline) throw new WaitTimeoutError(last);
    await sleep(pause);
  }
}

const VERDICT_TEXT = { PASSED: "Passed", FAILED: "Failed", BLOCKED: "Blocked", INCONCLUSIVE: "Inconclusive" };
const VERDICT_MARK = { PASSED: "✅", FAILED: "❌", BLOCKED: "⛔", INCONCLUSIVE: "❔" };
const CHANGE_TEXT = { regressed: "Regressed", fixed: "Fixed", changed: "Changed", unchanged: "Unchanged", new: "First run" };

/** Text that can't become Markdown structure inside a table cell or a link. */
export const md = (/** @type {string} */ text) => text.replace(/[\r\n]+/g, " ").replace(/[\\`*_[\]<>|~#]/g, (c) => `\\${c}`);

/**
 * A suite run as Markdown (the job summary): the verdict, the counts, regressions, and every test with a link.
 * @param {SuiteRun} run
 * @param {string} webUrl
 */
export function summaryMarkdown(run, webUrl) {
  const base = webUrl.replace(/\/+$/, "");
  const verdict = run.verdict ? `${VERDICT_MARK[run.verdict]} ${VERDICT_TEXT[run.verdict]}` : "⏳ Still running";
  const c = run.counts;
  const parts = [
    c.passed && `${c.passed} passed`,
    c.failed && `${c.failed} failed`,
    c.blocked && `${c.blocked} blocked`,
    c.inconclusive && `${c.inconclusive} inconclusive`,
    c.noVerdict && `${c.noVerdict} without a result`,
    c.active && `${c.active} still running`,
  ].filter(Boolean);
  const lines = [
    `## ${verdict}: suite “${md(run.suiteName)}”`,
    "",
    `[Open the suite run](${base}/suite-runs/${encodeURIComponent(run.id)}) · ${c.total} ${c.total === 1 ? "test" : "tests"}: ${parts.join(", ") || "none"}`,
  ];
  if (run.changes && (run.changes.regressed > 0 || run.changes.fixed > 0)) {
    lines.push("", `Since their previous run: ${run.changes.regressed} regressed, ${run.changes.fixed} fixed.`);
  }
  lines.push("", "| Test | Result | Since the previous run |", "|---|---|---|");
  for (const child of run.children) {
    const result = child.verdict ? `${VERDICT_MARK[child.verdict]} ${VERDICT_TEXT[child.verdict]}` : md(child.lifecycle);
    lines.push(`| [${md(child.title || child.targetUrl)}](${base}/runs/${encodeURIComponent(child.runId)}) | ${result} | ${child.change ? CHANGE_TEXT[child.change] : "—"} |`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Parses a `fail-on` list ("FAILED,BLOCKED"); throws on an unknown verdict.
 * @param {string} text
 * @returns {Verdict[]}
 */
export function parseFailOn(text) {
  const list = text
    .split(/[\s,]+/)
    .map((v) => v.trim().toUpperCase())
    .filter(Boolean);
  for (const v of list) if (!(/** @type {readonly string[]} */ (VERDICTS).includes(v))) throw new Error(`Unknown verdict “${v}” (use ${VERDICTS.join(", ")})`);
  return /** @type {Verdict[]} */ (list);
}

/**
 * Finds the suite, starts a run, and (with `wait`) waits for it, writes its JUnit file and decides the exit code:
 * 0 passed (or not waited for), 1 a verdict in `failOn`, 2 usage or platform error, 3 timed out.
 * @param {{
 *   client: PlatformClient; suite: string; wait?: boolean; timeoutMs?: number; intervalMs?: number; failOn?: Verdict[];
 *   junitPath?: string; context?: CiContext; idempotencyKey?: string;
 *   writeFile?: (path: string, text: string) => Promise<void>; log?: (line: string) => void; sleep?: (ms: number) => Promise<void>;
 * }} opts
 * @returns {Promise<{ exitCode: 0 | 1 | 2 | 3; suiteRunId: string | null; url: string | null; verdict: Verdict | null; run: SuiteRun | null; message: string }>}
 */
export async function runSuiteAndWait(opts) {
  const { client, wait = true, failOn = ["FAILED"], log = () => {} } = opts;
  let suiteRunId = null;
  let url = null;
  try {
    const suite = await opts.client.findSuite(opts.suite);
    const started = await client.runSuite(suite.id, {
      ...(opts.context ? { context: opts.context } : {}),
      ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
    });
    suiteRunId = started.suiteRunId;
    url = client.suiteRunUrl(suiteRunId);
    log(`Started ${started.runIds.length} ${started.runIds.length === 1 ? "test" : "tests"} of suite “${suite.name}”: ${url}`);
    if (!wait) return { exitCode: 0, suiteRunId, url, verdict: null, run: null, message: "Started; not waiting for the result" };

    let seen = -1;
    const run = await waitForSuiteRun(client, suiteRunId, {
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.intervalMs !== undefined ? { intervalMs: opts.intervalMs } : {}),
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
      onProgress: (r) => {
        const done = r.counts.total - r.counts.active;
        if (done !== seen) log(`${done} of ${r.counts.total} finished`);
        seen = done;
      },
    });
    if (opts.junitPath && opts.writeFile) {
      await opts.writeFile(opts.junitPath, await client.junit(suiteRunId));
      log(`JUnit report written to ${opts.junitPath}`);
    }
    const verdict = run.verdict;
    const failed = verdict !== null && failOn.includes(verdict);
    const message = `Suite “${run.suiteName}”: ${verdict ? VERDICT_TEXT[verdict] : "no verdict"}`;
    return { exitCode: failed ? 1 : 0, suiteRunId, url, verdict, run, message };
  } catch (err) {
    if (err instanceof WaitTimeoutError) {
      return { exitCode: 3, suiteRunId, url, verdict: null, run: err.last, message: "Timed out waiting for the suite run; it goes on in the platform" };
    }
    const message = err instanceof PlatformError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err);
    return { exitCode: 2, suiteRunId, url, verdict: null, run: null, message };
  }
}
