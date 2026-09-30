import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { TestEvent, TestReport, TestRunSummary } from "@platform/contracts";
import { ArtifactRepository, EventRepository, GeneratedTestRepository, LlmCallRepository, SecretRepository, createDb } from "@platform/db";
import { sql } from "drizzle-orm";
import type { E2EStack } from "./stack";

const TERMINAL = ["COMPLETED", "ERRORED", "CANCELLED"];

/**
 * The API as the web app's server calls it (bearer token). With `session`, as a signed-in user (the web
 * server forwards the session as X-Session-Token); without, as the service (unrestricted).
 */
export function api(stack: E2EStack, session?: string) {
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${stack.apiUrl}${url}`, {
      method,
      headers: {
        authorization: `Bearer ${stack.apiToken}`,
        ...(session ? { "x-session-token": session } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as any) : null, text };
  };
  const self = {
    call,
    async create(body: Record<string, unknown>): Promise<string> {
      const res = await call("POST", "/v1/test-runs", body);
      if (res.status !== 202) throw new Error(`create → ${res.status} ${JSON.stringify(res.json)}`);
      return res.json.runId as string;
    },
    get: async (runId: string): Promise<TestRunSummary> => (await call("GET", `/v1/test-runs/${runId}`)).json,
    /** Polls until `done(summary)`; fails fast when the run ends in a lifecycle `done` does not accept. */
    async waitFor(runId: string, done: (r: TestRunSummary) => boolean, timeoutMs = 150_000): Promise<TestRunSummary> {
      const deadline = Date.now() + timeoutMs;
      let last: TestRunSummary | undefined;
      while (Date.now() < deadline) {
        last = await self.get(runId);
        if (done(last)) return last;
        if (TERMINAL.includes(last.lifecycle)) throw new Error(`run ${runId} ended ${JSON.stringify(last)} before the awaited state`);
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error(`timed out waiting for run ${runId}; last ${JSON.stringify(last)}`);
    },
    finished: (runId: string, timeoutMs?: number) => self.waitFor(runId, (r) => TERMINAL.includes(r.lifecycle), timeoutMs),
    report: async (runId: string): Promise<TestReport> => (await call("GET", `/v1/test-runs/${runId}/report`)).json,
    criteria: async (runId: string) => (await call("GET", `/v1/test-runs/${runId}/criteria`)).json,
    putCriteria: (runId: string, body: unknown) => call("PUT", `/v1/test-runs/${runId}/criteria`, body),
    confirm: (runId: string) => call("POST", `/v1/test-runs/${runId}/criteria/confirm`),
    suggestions: (runId: string) => call("GET", `/v1/test-runs/${runId}/suggestions`),
    select: (runId: string, body: unknown) => call("POST", `/v1/test-runs/${runId}/suggestions/select`, body),
    cancel: (runId: string) => call("POST", `/v1/test-runs/${runId}/cancel`),
    artifactUrl: async (runId: string, artifactId: string, reveal = false): Promise<{ url: string }> =>
      (await call("GET", `/v1/test-runs/${runId}/artifacts/${artifactId}/url${reveal ? "?reveal=true" : ""}`)).json,
    llmSettings: () => call("GET", "/v1/settings/llm"),
    putProviderKey: (provider: "anthropic" | "gemini" | "deepseek", apiKey: string | null) => call("PUT", `/v1/settings/llm/keys/${provider}`, { apiKey }),
  };
  return self;
}

/** Direct reads of the E2E database (what the platform persisted). */
export function db(stack: E2EStack) {
  const handle = createDb(stack.databaseUrl, { max: 2 });
  return {
    handle,
    events: (runId: string): Promise<TestEvent[]> => new EventRepository(handle.db).listAfter(runId, 0, 5000),
    artifacts: (runId: string) => new ArtifactRepository(handle.db).listByRun(runId),
    generatedTest: (runId: string) => new GeneratedTestRepository(handle.db).findByRun(runId),
    secretsActive: (runId: string) => new SecretRepository(handle.db).listActive(runId),
    llmCalls: (runId: string) => new LlmCallRepository(handle.db).listByRun(runId),
    /** The Settings tables' rows (saved defaults, encrypted provider keys), as JSON text. */
    async settingsRows(): Promise<string> {
      const rows = await handle.db.execute<{ j: string }>(
        sql`SELECT row_to_json(s)::text AS j FROM llm_settings s UNION ALL SELECT row_to_json(k)::text AS j FROM llm_provider_keys k`,
      );
      return rows.rows.map((r) => r.j).join("\n");
    },
    /** Every table's rows that belong to the run (a run_id column, or the run row itself), as JSON text. */
    async rowsOf(runId: string): Promise<string> {
      const tables = await handle.db.execute<{ table_name: string }>(
        sql`SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'run_id'`,
      );
      const out: string[] = [];
      for (const { table_name } of tables.rows) {
        const rows = await handle.db.execute<{ j: string }>(
          sql`SELECT row_to_json(t)::text AS j FROM ${sql.identifier(table_name)} t WHERE t.run_id = ${runId}`,
        );
        out.push(...rows.rows.map((r) => r.j));
      }
      const run = await handle.db.execute<{ j: string }>(sql`SELECT row_to_json(t)::text AS j FROM test_runs t WHERE t.id = ${runId}`);
      out.push(...run.rows.map((r) => r.j));
      return out.join("\n");
    },
    close: () => handle.close(),
  };
}

/** Everything the API and worker processes logged. */
export function logs(stack: E2EStack): string {
  return readdirSync(stack.logDir)
    .map((f) => readFileSync(path.join(stack.logDir, f), "utf8"))
    .join("\n");
}

/**
 * Command lines of the worker's live processes that mention `text` (e.g. a run id in a sandbox profile
 * dir): on this machine, or inside the worker's container.
 */
export function processesMentioning(stack: E2EStack, text: string): string[] {
  const ps = ["ps", "-axo", "pid=,command="];
  const [file, ...args] = stack.workerContainer ? ["docker", "exec", stack.workerContainer, ...ps] : ps;
  const out = execFileSync(file!, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out.split("\n").filter((l) => l.includes(text) && !l.includes("ps -axo"));
}

/** Whether the run's Playwright workspace (`<RUNNER_WORKSPACE_DIR>/<runId>`) exists where the worker runs. */
export function runnerWorkspaceExists(stack: E2EStack, runId: string): boolean {
  if (!stack.workerContainer) return existsSync(path.join(stack.runnerDir, runId));
  try {
    execFileSync("docker", ["exec", stack.workerContainer, "test", "-e", path.posix.join(stack.runnerDir, runId)]);
    return true;
  } catch {
    return false;
  }
}

/**
 * A secret value in every form the platform's redactors and trace scrubber mask: raw, URL- and
 * form-encoded, base64 (padded, unpadded, URL-safe), JSON- and HTML-escaped.
 */
export function secretForms(value: string): string[] {
  const b64 = Buffer.from(value, "utf8").toString("base64");
  const html = value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
  return [
    ...new Set([
      value,
      encodeURIComponent(value),
      new URLSearchParams([["", value]]).toString().slice(1),
      b64,
      b64.replace(/=+$/, ""),
      Buffer.from(value, "utf8").toString("base64url"),
      JSON.stringify(value).slice(1, -1),
      html,
    ]),
  ];
}

export async function shopStats(stack: E2EStack): Promise<{ deleteClicks: number }> {
  return (await fetch(`${stack.shopUrl}/__test/stats`)).json() as Promise<{ deleteClicks: number }>;
}

/** The demo shop's request log (method + path, never the query), oldest first; `seq` only grows. */
export async function shopRequests(stack: E2EStack): Promise<{ seq: number; method: string; path: string }[]> {
  const body = (await (await fetch(`${stack.shopUrl}/__test/requests`)).json()) as { requests: { seq: number; method: string; path: string }[] };
  return body.requests;
}

/** Sum of a metric's samples whose labels include `labels` (Prometheus text format). */
export function metricValue(text: string, name: string, labels: Record<string, string> = {}): number {
  let sum = 0;
  for (const line of text.split("\n")) {
    const m = new RegExp(`^${name}(?:\\{([^}]*)\\})? (\\S+)$`).exec(line);
    if (!m) continue;
    const have = Object.fromEntries([...(m[1] ?? "").matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
    if (Object.entries(labels).every(([k, v]) => have[k] === v)) sum += Number(m[2]);
  }
  return sum;
}
