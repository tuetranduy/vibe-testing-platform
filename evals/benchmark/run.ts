/**
 * `pnpm benchmark` — runs the quality benchmark (evals/benchmark/README.md) against a running platform through its public
 * API, and writes `results.json` and `summary.md` under `.artifacts/benchmark/<timestamp>/`.
 *
 *   pnpm benchmark [--sites demo-shop,frontends-demo] [--cases DS-01,DB-02] [--repeat 3] [--concurrency 2]
 *                  [--compare .artifacts/benchmark/<earlier>/results.json] [--model deepseek-flash] [--reasoning minimal]
 *
 * API_URL (default http://localhost:3001) and API_TOKEN (else the .env's) reach the API; BENCH_DEMO_SHOP_URL (default
 * http://demo-shop:4000) is the demo shop as the worker sees it. Runs are auto-confirmed with default options. A 429
 * (the tenant's active-run limit) waits and tries again. Exits 0 once every run finished: scores are recorded in
 * evals/BASELINE.md, not enforced.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { TestReportSchema, type TestReport } from "@platform/contracts";
import { renderMarkdown, summarize, type BenchmarkCase, type BenchmarkSummary, type CaseRun } from "./metrics";

const ROOT = path.resolve(import.meta.dirname, "../..");
const TERMINAL = new Set(["COMPLETED", "ERRORED", "CANCELLED"]);
const POLL_MS = 10_000;
const BUSY_WAIT_MS = 20_000;
/** A run still refused for being over the active-run limit after this long is recorded as errored (review finding). */
const BUSY_GIVE_UP_MS = 30 * 60_000;
const RUN_TIMEOUT_MS = 30 * 60_000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const list = (v: string | undefined) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : null);

function apiToken(): string {
  if (process.env.API_TOKEN) return process.env.API_TOKEN;
  try {
    const env = readFileSync(path.join(ROOT, ".env"), "utf8");
    const m = /^API_TOKEN=(.*)$/m.exec(env)?.[1]?.replace(/^['"]|['"]$/g, "");
    if (m) return m;
  } catch {
    // no .env: the development default below
  }
  return "dev-api-token-change-me-please";
}

const API = process.env.API_URL ?? "http://localhost:3001";
const TOKEN = apiToken();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function request<T>(pathname: string, method = "GET", body?: unknown, key?: string): Promise<T> {
  const res = await fetch(API + pathname, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, `${method} ${pathname}: ${res.status} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : null) as T;
}

function loadCases(): BenchmarkCase[] {
  const corpus = JSON.parse(readFileSync(path.join(import.meta.dirname, "corpus.json"), "utf8")) as { cases: BenchmarkCase[] };
  const demoShop = (process.env.BENCH_DEMO_SHOP_URL ?? "http://demo-shop:4000").replace(/\/+$/, "");
  const sites = list(arg("sites"));
  const ids = list(arg("cases"));
  return corpus.cases
    .filter((c) => (!sites || sites.includes(c.site)) && (!ids || ids.includes(c.id)))
    .map((c) => ({ ...c, targetUrl: c.targetUrl.replace("{demoShop}", demoShop) }));
}

/** Creates the run (waiting while the platform is at its active-run limit), then waits for its report. */
async function runCase(c: BenchmarkCase, repeat: number, stamp: string): Promise<CaseRun> {
  const model = arg("model");
  const reasoning = arg("reasoning");
  const body = {
    targetUrl: c.targetUrl,
    requirement: c.requirement,
    options: { autoConfirmCriteria: true },
    ...(model || reasoning ? { llm: { ...(model ? { model } : {}), ...(reasoning ? { reasoning } : {}) } } : {}),
  };
  let runId: string;
  const waitingSince = Date.now();
  for (;;) {
    try {
      runId = (await request<{ runId: string }>("/v1/test-runs", "POST", body, `bench-${stamp}-${c.id}-${repeat}`)).runId;
      break;
    } catch (err) {
      if (err instanceof HttpError && err.status === 429 && Date.now() - waitingSince < BUSY_GIVE_UP_MS) {
        await sleep(BUSY_WAIT_MS);
        continue;
      }
      return { caseId: c.id, repeat, runId: null, lifecycle: "ERRORED", report: null, error: String(err) };
    }
  }
  console.log(`${c.id} #${repeat}: ${runId}`);
  const started = Date.now();
  let lifecycle = "QUEUED";
  while (!TERMINAL.has(lifecycle)) {
    if (Date.now() - started > RUN_TIMEOUT_MS) return { caseId: c.id, repeat, runId, lifecycle, report: null, error: "timed out waiting" };
    await sleep(POLL_MS);
    lifecycle = (await request<{ lifecycle: string }>(`/v1/test-runs/${runId}`).catch(() => ({ lifecycle }))).lifecycle;
  }
  let report: TestReport | null = null;
  for (let i = 0; i < 6 && !report; i++) {
    try {
      report = TestReportSchema.parse(await request(`/v1/test-runs/${runId}/report`));
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 409)) break;
      await sleep(5_000);
    }
  }
  console.log(`${c.id} #${repeat}: ${lifecycle} ${report?.verdict ?? "(no report)"}`);
  return { caseId: c.id, repeat, runId, lifecycle, report };
}

async function main(): Promise<void> {
  const cases = loadCases();
  const repeat = Math.max(1, Number(arg("repeat") ?? 1));
  const concurrency = Math.max(1, Number(arg("concurrency") ?? 2));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = path.join(ROOT, ".artifacts/benchmark", stamp);
  mkdirSync(out, { recursive: true });
  console.log(`${cases.length} cases × ${repeat}, ${concurrency} at a time → ${path.relative(ROOT, out)}`);

  const queue = cases.flatMap((c) => Array.from({ length: repeat }, (_, i) => [c, i + 1] as const));
  const runs: CaseRun[] = [];
  const save = () => writeFileSync(path.join(out, "results.json"), JSON.stringify({ cases, runs }, null, 2) + "\n");
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        runs.push(await runCase(next[0], next[1], stamp));
        save();
      }
    }),
  );

  const summary = summarize(cases, runs);
  const compare = arg("compare");
  let previous: BenchmarkSummary | undefined;
  if (compare) {
    const before = JSON.parse(readFileSync(path.resolve(compare), "utf8")) as { cases: BenchmarkCase[]; runs: CaseRun[] };
    previous = summarize(before.cases, before.runs);
  }
  const md = `# Quality benchmark ${stamp}\n\nAPI ${API}${arg("model") ? `, model ${arg("model")}` : ""}, ${repeat} repeat(s).\n\n${renderMarkdown(summary, previous)}`;
  writeFileSync(path.join(out, "summary.md"), md);
  console.log(`\n${md}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
