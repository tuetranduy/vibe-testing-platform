# Admin Run Logs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin-only Logs view of each run: every run-tagged log line from worker, API, runner, Browser Use, infra
events, our web app and the tested site, plus every model call with its full prompt and response, kept 14 days.

**Architecture:** The shared JSON-lines logger gains a second destination: a buffered, never-throwing sink that
batch-inserts every line carrying `runId` into a new `run_logs` table. Model calls also store their exact redacted
request and response, gzipped, in a new `llm_call_exchanges` table. Admin-only API routes read both; the web app adds
a Logs section on the run page and a frontend-error reporter. The existing daily retention job deletes both after
14 days.

**Tech Stack:** TypeScript, Drizzle + PostgreSQL, Fastify, BullMQ worker, Playwright, Next.js 16 / React 19, zod 4,
Vitest.

**Spec:** `docs/superpowers/specs/2026-11-25-admin-run-logs-design.md`

**Change from the spec (decided while planning):** prompt/response bodies go in Postgres (`llm_call_exchanges`,
gzipped `bytea`), not artifact storage. `ArtifactStorage` has no read operation (only signed URLs the *browser*
fetches), its object keys and `ArtifactType` are shared with the member-visible artifact list and report, and the
API would have to hand an admin's browser a direct link to prompt files. Postgres keeps the same crash-safety and
"no new services" reasons option 1 was chosen for. The spec's §5.1 is updated to match (Task 9).

## Global Constraints

- Admin only: every read route calls `requireAdmin(req.principal)` (403 for members); a run outside the tenant is 404.
- Retention: `RUN_LOG_RETENTION_DAYS`, default **14**, for `run_logs` rows and `llm_call_exchanges` rows.
- Per-run cap: `RUN_LOG_MAX_LINES`, default **20000**. Past it, `warn`+ lines are still stored, lower levels dropped,
  and one `infra` line `"run log line cap reached"` records it (once per run per process).
- A single `fields` string value longer than **16 KB** (16384 chars) is cut and suffixed `…[truncated N chars]`.
- Sink flush: every **500 ms** or **200** lines; buffer bound **5000** lines per process; a full buffer drops the
  oldest `trace`/`debug`/`info` lines first, then the oldest of any level.
- `source` values exactly: `worker` `api` `runner` `browser_use` `infra` `web_app` `target_site`.
- Client logs: max **50** lines per request, **4 KB** (4096 chars) per message, **300** `web_app` lines per run per user.
- Live view polls every **3 s** while the run is not terminal.
- Logging must never throw into, slow down, or change the outcome of a run or request. Stdout lines stay exactly as
  today.
- Browser Use prompts/responses are **not** captured (its isolation contract); only its JSON diagnostics lines.
- Secrets are shown as logged (no extra masking): the logger's existing key-based + run redaction is the only filter.
- DB tests need the compose Postgres: `pnpm infra:up` and `TEST_DATABASE_URL` as in `packages/db/src/testing.ts`.

## Review Focus

1. **Database slow or down mid-run:** the run finishes with its normal outcome; lines are dropped and counted
   (`run_log_dropped_total{reason="insert_failed"}`) and one stdout warning is written. → Task 3 test
   `insert failure never rejects and is counted`.
2. **A line for a run that does not exist (deleted, typo, other process's id):** dropped silently; the other runs'
   lines in the same batch are still stored. → Task 2 test `appendMany skips lines of unknown runs`.
3. **One enormous line (a 1 MB stack or HTML body in an error):** stored with each long string cut at 16 KB, never
   rejected. → Task 3 test `cuts long field strings`.
4. **A member, or an admin of another tenant, calling any logs/llm route directly:** 403 / 404, never data.
   → Task 7 tests `member gets 403` and `other tenant's run is 404`.
5. **Opening a prompt after 14 days, or for a run from before release:** "Prompt expired" / "No logs were recorded
   for this run.", not an error banner. → Task 7 test `expired exchange is 410`; Task 8 test `shows the empty state`.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/contracts/src/run-logs.ts` (new) | zod schemas: sources, levels, line, page, query, LLM call view, exchange, client batch |
| `packages/db/src/schema.ts` | `runLogs`, `llmCallExchanges` tables; `llmCalls.purpose` |
| `packages/db/migrations/0020_run_logs.sql` (+ meta via `db:generate`) | the migration, with tenant trigger + RLS like 0019 |
| `packages/db/src/run-log-repository.ts` (new) | append, list (filters, cursor), count, delete-older-than |
| `packages/db/src/llm-exchange-repository.ts` (new) | gzip write, read, delete-older-than |
| `packages/config/src/run-log-sink.ts` (new) | buffer, flush, cap, truncation, source classification |
| `packages/config/src/logger.ts` | optional `sink` on `LoggerOptions` |
| `packages/config/src/env.ts` | `RUN_LOG_RETENTION_DAYS`, `RUN_LOG_MAX_LINES` |
| `packages/llm/src/types.ts`, `llm-client.ts` | `purpose` + `exchange` on `LlmCallRecord` |
| `apps/worker/src/run-llm.ts` | store the exchange with the call |
| `apps/worker/src/boot.ts`, `jobs/retention.ts` | wire sink; delete expired logs/exchanges |
| `apps/worker/src/{sandbox/*, discovery-client.ts, rerun.ts}`, `packages/event-bus/src/reaper.ts` | `source: "infra"` tags; Browser Use + runner lines |
| `apps/worker/src/sandbox/target-site-watch.ts` (new) | tested-site console / page errors / failed requests |
| `apps/api/src/routes/run-logs.ts` (new), `apps/api/src/main.ts`, `app.ts` | routes, sink, request-log hook |
| `apps/web/lib/api.ts`, `apps/web/lib/client-log-reporter.ts` (new) | client calls; frontend error reporter |
| `apps/web/components/RunLogs/*` (new), `RunView.tsx`, `app/runs/[runId]/logs/page.tsx` (new) | the view |
| `docs/operations.md`, `README.md`, the spec | docs |

---

### Task 1: Contracts

**Files:**
- Create: `packages/contracts/src/run-logs.ts`
- Modify: `packages/contracts/src/index.ts` (export it)
- Test: `packages/contracts/src/run-logs.test.ts`

**Interfaces — Produces:**
- `RunLogSourceSchema = z.enum(["worker","api","runner","browser_use","infra","web_app","target_site"])`, `RunLogSource`
- `RunLogLevelSchema = z.enum(["trace","debug","info","warn","error","fatal"])`, `RunLogLevel`
- `RunLogLineSchema = { id: string, time: string (ISO), source, level, stage: RunLifecycle | null, component: string, message: string, fields: Record<string, unknown> }`
- `RunLogQuerySchema = { after?: string, source?: RunLogSource[] (comma-separated in the query string), minLevel?: RunLogLevel, stage?: RunLifecycle, q?: string (max 200), limit?: int 1..1000 default 500 }`
- `RunLogPageSchema = { lines: RunLogLine[], nextCursor: string | null }`
- `LlmCallViewSchema = { id, time, stage, purpose: string | null, provider, model, inputTokens, outputTokens, estimatedCostUsd, latencyMs, status, exchange: "available" | "expired" | "none" }`
- `LlmExchangeSchema = { system: string, messages: { role: "user"|"assistant", content: unknown }[], response: string | null, error: string | null, truncated: boolean }`
- `ClientLogBatchSchema = { lines: { time: string, level: "warn"|"error", message: string (max 4096), url: string (max 2048), kind: "error"|"unhandledrejection"|"render"|"api", stack?: string (max 16384) }[] (1..50) }`

- [ ] **Step 1: Write failing tests** `run-logs.test.ts`: `RunLogQuerySchema.parse({ source: "worker,infra" }).source` equals `["worker","infra"]`; `limit` defaults to 500 and rejects 1001; `ClientLogBatchSchema` rejects 51 lines and a 4097-char message; `RunLogSourceSchema.options` equals the seven values in order.
- [ ] **Step 2: Run** `pnpm --filter @platform/contracts test -- run-logs` → FAIL (module missing).
- [ ] **Step 3: Implement** the schemas above; the `source` query field uses `z.preprocess` splitting on `,`.
- [ ] **Step 4: Run** the same command → PASS; `pnpm --filter @platform/contracts typecheck` → no errors.
- [ ] **Step 5: Commit** `feat(contracts): run log and LLM exchange schemas`.

---

### Task 2: Database tables and repositories

**Files:**
- Modify: `packages/db/src/schema.ts`, `packages/db/src/index.ts`, `packages/db/src/llm-call-repository.ts`
- Create: `packages/db/migrations/0020_run_logs.sql` (generate with `pnpm --filter @platform/db db:generate`, then append the trigger + RLS lines by hand as in `0019_run_findings.sql`), `packages/db/src/run-log-repository.ts`, `packages/db/src/llm-exchange-repository.ts`
- Test: `packages/db/src/run-log-repository.test.ts`, `packages/db/src/llm-exchange-repository.test.ts`, `packages/db/src/llm-call-repository.test.ts`

**Interfaces:**
- Consumes: Task 1 types.
- Produces:
  - Table `run_logs`: `id text pk`, `run_id` FK cascade, `tenant_id` (`runTenantId()` + `set_run_tenant_id` trigger), `time timestamptz`, `source text`, `level text`, `stage` (lifecycle enum, nullable), `component text`, `message text`, `fields jsonb`. Indexes `run_logs_run_time (run_id, time, id)`, `run_logs_time (time)`.
  - Table `llm_call_exchanges`: `llm_call_id text pk` FK `llm_calls.id` cascade, `run_id` FK cascade, `tenant_id` (trigger), `body bytea` (gzipped JSON of `LlmExchange`), `bytes integer`, `created_at`. Index on `created_at`.
  - `llm_calls.purpose text null`.
  - `interface NewRunLogLine { runId: string; time: Date; source: RunLogSource; level: RunLogLevel; stage: RunLifecycle | null; component: string; message: string; fields: Record<string, unknown> }`
  - `class RunLogRepository { appendMany(lines: NewRunLogLine[]): Promise<number>; list(tenantId: string, runId: string, query: RunLogQuery): Promise<RunLogPage>; count(runId: string): Promise<number>; countWebAppLines(runId: string, userId: string): Promise<number>; deleteOlderThan(cutoff: Date, limit: number): Promise<number> }`
  - `class LlmExchangeRepository { put(llmCallId: string, runId: string, exchange: LlmExchange): Promise<void>; get(tenantId: string, llmCallId: string): Promise<LlmExchange | null>; availability(runId: string): Promise<Set<string>>; deleteOlderThan(cutoff: Date, limit: number): Promise<number> }`
  - `NewLlmCall` gains `purpose?: string | null`; `LlmCallRepository.create` returns the row (already) so callers have its `id`; add `listForRun(tenantId: string, runId: string): Promise<LlmCallRow[]>` ordered by `created_at, id`.

- [ ] **Step 1: Write failing tests**
  - `appendMany stores lines with the run's tenant` (tenant from trigger, not passed).
  - `appendMany skips lines of unknown runs`: a batch with one real and one unknown `runId` returns `1` and stores only the real one (implement as `INSERT … SELECT … FROM (VALUES …) JOIN test_runs`).
  - `list orders by time then id and pages by cursor`: 5 lines, `limit: 2` → 3 pages, last `nextCursor` null; cursor is opaque base64 of `time|id`.
  - `list filters by source, minLevel, stage and q` (`q` is case-insensitive `ILIKE` on `message`).
  - `list never returns another tenant's run` → `{ lines: [], nextCursor: null }`.
  - `deleteOlderThan deletes at most limit rows older than cutoff`.
  - `exchange round-trips through gzip` and `get returns null for another tenant`.
  - `availability returns ids of calls that have an exchange`.
- [ ] **Step 2: Run** `pnpm --filter @platform/db test -- run-log-repository llm-exchange-repository llm-call-repository` → FAIL.
- [ ] **Step 3: Implement** schema, migration, repositories (gzip with `node:zlib` `gzipSync`/`gunzipSync`).
- [ ] **Step 4: Run** the same tests → PASS; `pnpm --filter @platform/db typecheck`.
- [ ] **Step 5: Commit** `feat(db): run_logs and llm_call_exchanges tables`.

---

### Task 3: Logger sink

**Files:**
- Create: `packages/config/src/run-log-sink.ts`
- Modify: `packages/config/src/logger.ts`, `packages/config/src/env.ts`, `packages/config/src/index.ts`
- Test: `packages/config/src/run-log-sink.test.ts`, `packages/config/src/logger.test.ts`

**Interfaces:**
- Consumes: `NewRunLogLine` shape (declared structurally here; `config` must not depend on `db`).
- Produces:
  - `LoggerOptions.sink?: (record: Record<string, unknown> & { level: LogLevel; time: string }) => void` — called with the final record (after enrichment and both redactions) only when it has a string `runId`; a throwing sink is caught and ignored.
  - `interface RunLogSinkOptions { component: string; write(lines: SinkLine[]): Promise<void>; maxLinesPerRun?: number; flushMs?: number; batchSize?: number; bufferLimit?: number; onDrop?(reason: "buffer_full" | "cap" | "insert_failed", n: number): void; onWriteError?(err: unknown): void }`
  - `type SinkLine` = `NewRunLogLine` (structural copy).
  - `createRunLogSink(opts): { accept(record): void; flush(): Promise<void>; close(): Promise<void> }` — `accept` is what goes into `LoggerOptions.sink`.
  - `classifySource(record, component): RunLogSource` — `record.source` if it is a valid source, else `component` when it is `worker`/`api`/`runner`, else `worker`. The `source` key is removed from `fields`.
  - Env: `RUN_LOG_RETENTION_DAYS: intWithDefault(14)`, `RUN_LOG_MAX_LINES: intWithDefault(20000)`.

- [ ] **Step 1: Write failing tests** (fake timers, in-memory `write`):
  - `flushes every 500 ms or at 200 lines`.
  - `maps a record to a line`: `msg`→`message`, `time`→`Date`, `stage` kept, `level`/`component`/`runId`/`msg`/`time`/`stage`/`source` not repeated in `fields`.
  - `cuts long field strings`: a 20 000-char nested string becomes 16 384 chars + `…[truncated 3616 chars]`.
  - `after the cap keeps warn and above`: `maxLinesPerRun: 3`, 5 info + 1 error → 3 info + 1 cap line (`source: "infra"`, level `warn`, message `run log line cap reached`) + 1 error; `onDrop("cap", 2)`.
  - `a full buffer drops oldest low-level lines first`.
  - `insert failure never rejects and is counted`: `write` rejects → `flush()` resolves, `onDrop("insert_failed", n)`, `onWriteError` called once per failed flush.
  - In `logger.test.ts`: `sink receives redacted, enriched run lines only` (line without `runId` not passed; `password` field redacted); `a throwing sink does not stop stdout`.
- [ ] **Step 2: Run** `pnpm --filter @platform/config test -- run-log-sink logger` → FAIL.
- [ ] **Step 3: Implement.** The timer is `unref()`ed; `close()` flushes and stops the timer. Per-run counts live in a `Map<runId, number>` seeded lazily from 0 (cap is per process; that is acceptable — see spec §5.1).
- [ ] **Step 4: Run** → PASS; `pnpm --filter @platform/config typecheck`.
- [ ] **Step 5: Commit** `feat(config): buffered run log sink for the logger`.

---

### Task 4: Model call prompts and responses

**Files:**
- Modify: `packages/llm/src/types.ts`, `packages/llm/src/llm-client.ts`, `apps/worker/src/run-llm.ts`
- Test: `packages/llm/src/llm-client.test.ts`, `apps/worker/src/run-llm.test.ts` (create if absent)

**Interfaces:**
- Consumes: Task 2 `LlmExchangeRepository.put`, `NewLlmCall.purpose`; Task 1 `LlmExchange`.
- Produces: `LlmCallRecord` gains `purpose: string | null` (from `input.schemaName ?? null`) and `exchange: { system: string; messages: LlmMessage[]; response: string | null; error: string | null }`. The `system`/`messages` are the **redacted** ones actually sent (`request()` returns them alongside `response`); `response` is `response.text`; `error` is the provider error message for `PROVIDER_ERROR`/`CANCELLED` records.

- [ ] **Step 1: Write failing tests**
  - `llm-client.test.ts`: `records the redacted request and the response text` (redactor replaces `"s3cret"` → `"[x]"`; the record's `exchange.messages` contains `"[x]"`, `exchange.response` equals the fake transport's text); `a correction round records its own messages` (second record's messages end with the correction prompt); `a provider error records the error and no response`; `purpose is the schemaName`.
  - `run-llm.test.ts`: `stores the call and its exchange`; `an exchange write failure keeps the call row and logs a warning`.
- [ ] **Step 2: Run** `pnpm --filter @platform/llm test -- llm-client` and `pnpm --filter @platform/worker test -- run-llm` → FAIL.
- [ ] **Step 3: Implement.** In `run-llm.ts`'s `recordCall`: `const row = await calls.create({ ...call without exchange, purpose })`, then `await exchanges.put(row.id, call.runId, { ...call.exchange, truncated })` inside its own try/catch that logs `warn { err, runId }, "failed to record LLM exchange"`. If the JSON of the exchange exceeds 4 MB (4 194 304 chars), keep `system` and the last two messages, replace earlier ones with `{ role: "user", content: "[omitted]" }` and set `truncated: true`.
- [ ] **Step 4: Run** both → PASS; typecheck both packages.
- [ ] **Step 5: Commit** `feat(llm): keep each model call's prompt and response`.

---

### Task 5: Worker sink, infra events, Browser Use, runner and retention

**Files:**
- Modify: `apps/worker/src/boot.ts`, `apps/worker/src/deps.ts`, `apps/worker/src/jobs/retention.ts`, `apps/worker/src/discovery-client.ts`, `apps/worker/src/rerun.ts`, `packages/testing-engine/src/playwright-runner/runner.ts`, `apps/worker/src/sandbox/runner-process.ts`, `apps/worker/src/sandbox/runner-service.ts`, `apps/worker/src/metrics.ts`
- Modify (add `source: "infra"` to the run-tagged log calls): `apps/worker/src/sandbox/{preflight,egress-events,run-sandbox,runner-process}.ts`, `packages/event-bus/src/reaper.ts`, the queue job-failure handler in `apps/worker/src/worker.ts`, artifact-storage failure lines in `apps/worker/src/jobs/finish.ts`
- Test: `apps/worker/src/jobs/retention.test.ts`, `apps/worker/src/discovery-client.test.ts`, `apps/worker/src/rerun.test.ts`, `apps/worker/src/boot-run-logs.test.ts` (new)

**Interfaces:**
- Consumes: Task 2 `RunLogRepository.appendMany/deleteOlderThan`, `LlmExchangeRepository.deleteOlderThan`; Task 3 `createRunLogSink`, `LoggerOptions.sink`.
- Produces:
  - `RunnerProcessInput.runId: string` (set by `runner.ts` from `RunGeneratedTestInput.runId`) and `RunnerProcessResult.stderrTail?: string` (local spawn: the existing tail; remote: the runner service includes it in its `/spawn` JSON response).
  - Metric `run_log_dropped_total{reason}` (counter).
  - `RetentionResult` gains `logLinesDeleted: number; exchangesDeleted: number`.

- [ ] **Step 1: Write failing tests**
  - `boot-run-logs.test.ts`: a logger built the way `boot.ts` builds it (extract `createWorkerLogging(env, db, metrics)` returning `{ logger, runLogs, sink }`) writes a `runId` line into `run_logs` with `source: "worker"`, and a line with `source: "infra"` is stored as `infra`.
  - `retention.test.ts`: `deletes log lines and exchanges older than RUN_LOG_RETENTION_DAYS` (15-day-old rows gone, 13-day-old kept, counts returned); runs after the artifact loop within the same pass time limit, batches of 5000.
  - `discovery-client.test.ts`: `forwards each valid diagnostics line as a browser_use log line` — a new `onDiagnostic?(line: Record<string, unknown>)` option receives every JSON stderr line ≤ 512 chars whose `runId` matches; the worker caller logs it as `logger.info({ runId, source: "browser_use", ...line }, line.event ?? "browser use")`. Progress handling unchanged.
  - `rerun.test.ts`: `logs the runner's stderr tail as runner lines` — `countedSpawn` logs each non-empty line of `stderrTail` (last 200 lines) as `info { runId, source: "runner" }`.
- [ ] **Step 2: Run** `pnpm --filter @platform/worker test -- retention discovery-client rerun boot-run-logs` → FAIL.
- [ ] **Step 3: Implement.** In `boot.ts`: build the sink with `write: (l) => new RunLogRepository(db).appendMany(l)`, `maxLinesPerRun: env.RUN_LOG_MAX_LINES`, `onDrop` → metric, `onWriteError` → one stdout warn per minute at most; pass `sink.accept` to `createLogger`; `await sink.close()` in shutdown before the DB closes. Retention reads `RUN_LOG_RETENTION_DAYS` from deps.
- [ ] **Step 4: Run** the tests → PASS; `pnpm --filter @platform/worker typecheck && pnpm --filter @platform/testing-engine typecheck`.
- [ ] **Step 5: Commit** `feat(worker): store run log lines, infra events, Browser Use and runner lines`.

---

### Task 6: Tested-site console, page errors and failed requests

**Files:**
- Create: `apps/worker/src/sandbox/target-site-watch.ts`
- Modify: `apps/worker/src/sandbox/browser-launcher.ts` (`LaunchSandboxedBrowserOptions.onTargetSite?`), `apps/worker/src/sandbox/run-sandbox.ts` (pass a logger-backed handler)
- Test: `apps/worker/src/sandbox/target-site-watch.test.ts`

**Interfaces:**
- Produces: `type TargetSiteEvent = { kind: "console"; level: "error" | "warning"; text: string; url: string } | { kind: "pageerror"; message: string; stack?: string; url: string } | { kind: "requestfailed"; method: string; url: string; failure: string } | { kind: "response"; method: string; url: string; status: number }`; `watchTargetSite(context: BrowserContext, on: (e: TargetSiteEvent) => void): () => void` — attaches to existing and new pages; `response` only for status ≥ 400; console only `error`/`warning`; ignores the CDP/extension pages (`chrome-extension://`, `devtools://`); never throws from a handler. Max 1000 events per page, then stops counting silently.
- `run-sandbox.ts` logs each as `deps.logger.warn` (`pageerror`, `requestfailed`, `response` ≥ 500, console error) or `info` (console warning, `response` 4xx) with `{ runId, source: "target_site", ...event }` and message `target site: <kind>`.

- [ ] **Step 1: Write failing tests** with a real Playwright page against a `data:`/local HTTP fixture (follow existing sandbox tests' setup): `reports console errors and warnings but not logs`; `reports uncaught page errors with stack`; `reports failed requests and 4xx/5xx responses, not 2xx`; `follows pages opened later`; `dispose stops reporting`.
- [ ] **Step 2: Run** `pnpm --filter @platform/worker test -- target-site-watch` → FAIL.
- [ ] **Step 3: Implement**, attach in `launchSandboxedBrowser` right after `applySessionHygiene`, disposed in `browser.close()`.
- [ ] **Step 4: Run** → PASS; worker typecheck.
- [ ] **Step 5: Commit** `feat(worker): log the tested site's console, page errors and failed requests`.

---

### Task 7: API — sink, request lines and routes

**Files:**
- Create: `apps/api/src/routes/run-logs.ts`
- Modify: `apps/api/src/app.ts` (register routes + `onResponse` hook), `apps/api/src/main.ts` (logger sink, close on shutdown), `apps/api/src/deps.ts` if a repo needs wiring
- Modify: `docs/operations.md` (§Logs: the `run_logs` destination, sources, cap, retention, the metric; §Retention: 14-day deletion)
- Test: `apps/api/src/routes/run-logs.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3; `requireAdmin`, `runScope` from `apps/api/src/auth/principal.ts`.
- Produces routes:
  - `GET /v1/test-runs/:runId/logs` (query `RunLogQuerySchema`) → `RunLogPage`. Admin only; 404 `RUN_NOT_FOUND` for a run outside the tenant.
  - `GET /v1/test-runs/:runId/llm-calls` → `{ calls: LlmCallView[], totals: { calls, inputTokens, outputTokens, estimatedCostUsd } }`; `exchange` is `available` if a row exists, `expired` if the call is older than `RUN_LOG_RETENTION_DAYS`, else `none`.
  - `GET /v1/test-runs/:runId/llm-calls/:callId/exchange` → `LlmExchange`; 410 `EXCHANGE_EXPIRED` when the call exists but its exchange is gone; 404 otherwise.
  - `POST /v1/test-runs/:runId/client-logs` (`ClientLogBatchSchema`) → 204. Any user who can see the run (`runs.getRequired(runScope(principal), runId)`); lines beyond the 300-per-run-per-user budget are dropped silently (still 204); each stored with `source: "web_app"`, `component: "web"`, `fields: { userId, kind, url, stack }`. Not for service/API-token principals (403).
  - Request lines: an `onResponse` hook logs `info { runId: req.params.runId, method, route: req.routeOptions.url, status, durationMs, principal: kind }, "request"` for routes whose pattern contains `:runId`, **except** the logs/llm-calls/client-logs routes themselves (so the live view does not log itself).

- [ ] **Step 1: Write failing tests** (use `test-support.ts` `buildApp` fixtures):
  - `member gets 403` on all three GET routes; `other tenant's run is 404`.
  - `admin pages logs with filters` (seed via repository).
  - `llm-calls lists calls with totals and exchange availability`.
  - `expired exchange is 410`.
  - `client-logs stores web_app lines for a member who owns the run`, `rejects 51 lines with 400`, `drops lines past 300 per user and still answers 204`, `another member's run is 404`.
  - `a run route writes a request line; the logs route does not`.
- [ ] **Step 2: Run** `pnpm --filter @platform/api test -- run-logs` → FAIL.
- [ ] **Step 3: Implement.** In `main.ts` pass the sink to the app's own `createLogger` (component `api`); Fastify's pino access log is unchanged.
- [ ] **Step 4: Run** → PASS; `pnpm --filter @platform/api typecheck`.
- [ ] **Step 5: Commit** `feat(api): admin run logs and model call routes`.

---

### Task 8: Web — Logs view and frontend error reporter

**Files:**
- Modify: `apps/web/lib/api.ts` (`getRunLogs`, `getRunLlmCalls`, `getLlmExchange`, `postClientLogs`), `apps/web/components/RunView.tsx`, `README.md` (Recent improvements entry)
- Create: `apps/web/lib/client-log-reporter.ts`, `apps/web/components/RunLogs/RunLogs.tsx`, `RunLogs/LogTimeline.tsx`, `RunLogs/LlmCallsTable.tsx`, `RunLogs/LlmExchangeDialog.tsx`, `RunLogs/FailureSummary.tsx`, `apps/web/app/runs/[runId]/logs/page.tsx`
- Test: `apps/web/components/RunLogs/RunLogs.test.tsx`, `apps/web/lib/client-log-reporter.test.ts`

**Interfaces:**
- Consumes: Task 7 routes through the existing `/api/[...path]` proxy; `useMe()`; Task 1 schemas.
- Produces:
  - `startClientLogReporter(runId: string): () => void` — listens to `window` `error` and `unhandledrejection`, accepts `report(kind, message, stack?)` from an error boundary and from `request()` failures (status ≥ 500 or `NETWORK_ERROR`) while active; batches and sends every 5 s or at 50, max 300 per page load; sending failures are swallowed and never reported again (no loop). Started by `RunView` for every signed-in user.
  - `<RunLogs runId run />`: admin-only (`useMe()?.role === "admin"`, renders nothing otherwise). Sections: **Why it failed** (only `ERRORED`/`FAILED`: the run's status reason + last 5 `error`/`fatal` lines, each with "Jump to line"), tabs **Timeline** and **Model calls (n)**, filters (source multi-select, minimum level, stage, search), expandable rows showing `fields` as formatted JSON, model calls shown inline in the timeline as one row each, polling `after=<cursor>` every 3 s while not terminal, **Download** (all pages as `.jsonl`). Exchange dialog shows system, messages, response with copy buttons; `410` → "Prompt expired (kept 14 days)".
  - Placement: a `Disclosure` titled "Logs" after "Run activity" in `RunView`, and `/runs/[runId]/logs` rendering `<RunLogs>` full-page; a member on that route sees the app's not-found state.
  - Empty state copy: `No logs were recorded for this run.`

- [ ] **Step 1: Write failing tests**
  - `RunLogs.test.tsx`: `renders nothing for a member`; `shows the failure summary for an errored run`; `filters by source and level` (query string sent); `polls while running and stops when terminal`; `opens a prompt` ; `shows prompt expired on 410`; `shows the empty state`.
  - `client-log-reporter.test.ts`: `batches window errors and posts them`; `caps at 300 per page load`; `a failed post is not reported again`.
- [ ] **Step 2: Run** `pnpm --filter @platform/web test -- RunLogs client-log-reporter` → FAIL.
- [ ] **Step 3: Implement** with existing UI primitives (`Card`, `Table`, `Disclosure`, `NativeSelect`, `Input`, `Button`) and the design tokens already used by `RunView`.
- [ ] **Step 4: Run** → PASS; `pnpm --filter @platform/web typecheck`.
- [ ] **Step 5: Commit** `feat(web): admin Logs view on the run page`.

---

### Task 9: End-to-end check

The spec already reflects the planning changes (prompt bodies in `llm_call_exchanges`; rerun tested-site capture
deferred).

- [ ] **Step 1:** `pnpm typecheck && pnpm test` → all pass.
- [ ] **Step 2:** `pnpm stack:up`, sign in as the bootstrap admin, run a test against the demo shop (and one that errors, e.g. a model with no key). Open the run: Logs shows worker, infra, target_site and model-call lines; a prompt opens; the failed run shows Why it failed. Sign in as a member: no Logs section, `/runs/<id>/logs` is not found, `GET /api/v1/test-runs/<id>/logs` is 403.
- [ ] **Step 3:** Fix anything found, re-run Step 1, commit.

**Deferred (noted in the spec):** the tested site's console during a Playwright *rerun* (runs inside the runner's
Playwright CLI); only its stderr tail is captured in this plan.
