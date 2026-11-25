# Admin run logs: every log line, model call and infrastructure event of one run

**Date:** 2026-11-25 · **Status:** approaches chosen in conversation; this spec awaits review.
**Scope:** a new admin-only **Logs** view of a run, the capture and storage behind it, and its 14-day retention.

## 1. Why

When a run fails, an administrator cannot see why without shell access to the servers: the API and worker write
JSON lines to container stdout, which nothing stores where the app can read it back. Model calls are recorded as
numbers only (`llm_calls` holds no prompt or output), so "the model misread the page" is invisible. The goal is one
place, inside the app, where an administrator can:

1. **See why a run failed:** the error that ended it and the lines leading up to it, from every part of the platform
   that touched it.
2. **Monitor model calls:** every call of the run, with its full prompt and response, model, tokens, cost, latency
   and status.
3. **Follow what happened during the run:** one timeline across all stages, live while the run is active.

**Success:** for a failed run, an administrator finds the cause on this page without opening a terminal.

## 2. Goals, non-goals, anti-goals

**Goals**
- Admin-only. Members never see the view, its API, or that it exists.
- Per run. Everything is scoped to one `test_runs` row.
- Sources: worker, API, runner, Browser Use discovery service, infrastructure events about the run (below), our web
  app's frontend errors, and the tested website's console / page errors / failed requests.
- Full prompt and response of every model call made through `LlmClient`.
- Kept 14 days, then deleted.
- Lines are stored as they happen, so a worker that crashes still leaves its last lines.

**Non-goals**
- Raw PostgreSQL, Redis or container output, or anything from a run's time window that is not tagged with the run
  (option B, declined). Can be added later with a log collector if a failure is ever traced there.
- A cross-run log search or a tenant-wide log explorer.
- Replacing stdout logging. Stdout lines stay exactly as they are; this adds a second destination.
- Alerting.

**Anti-goals (a failure even if it works)**
- Logging slowing down or failing a run. A full log table, a slow database or a failed write must never change a
  run's outcome or delay it noticeably.
- A member reaching another person's logs, or any log content, through any route.
- Unbounded growth: one runaway run filling the database.

## 3. Constraints found in the code

- **Roles.** `admin` and `member` exist; `requireAdmin(principal)` (`apps/api/src/auth/principal.ts`) gives 403.
  Service principals count as admin (`isAdmin`).
- **Logger.** `createLogger` (`packages/config/src/logger.ts`) already enriches every line that carries `runId` with
  `tenantId` and `stage` from the run registry and redacts it by key. That enriched, redacted record is what gets
  stored.
- **Secrets are not masked** (since 2026-10-07): a run's secret values can appear in log lines and prompts. The view
  is admin-only and short-lived for this reason; see §7.
- **Browser Use isolation.** The discovery service's contract is that its stderr carries "never page text, model
  output or agent code", and its model calls are brokered inside that service with its own key, not through
  `LlmClient`. This design keeps that boundary: Browser Use contributes its diagnostics lines (progress, summary,
  container start/exit/limits) but **not** its prompts and responses. Changing that is a separate security decision.
- **Artifacts.** `artifacts` rows carry `expiresAt`; the daily `retention` job deletes the object, then the row.
- **Live events** already stream over SSE (`test-run-events.ts`); the report page uses `RunView` with `Disclosure`
  sections ("Run activity").

## 4. Approaches considered

| | Approach | Trade-off |
|---|---|---|
| **1 (chosen)** | Log lines in a Postgres `run_logs` table; prompt/response bodies as compressed files in artifact storage, linked from `llm_calls` | Fast filtering, saved as it happens (crash-safe), live refresh, no new services. Costs Postgres rows; held in check by a per-run cap and 14-day deletion |
| 2 | One JSON-lines file per run in artifact storage | Lightest on the database, but lines are flushed in chunks, so the moments before a crash are the ones lost; no live view; clumsy filtering |
| 3 | External log tool (Loki, Datadog), linked from the run | Powerful search, but new infrastructure, a second sign-in, does nothing for prompts, and only pays off with raw infra logs (declined) |

Infrastructure scope: **A (chosen)**, events the platform records about the run, over **B**, every infra log in the
run's time window (needs a collector on the worker server and Cloudflare Containers; noisy, mixed runs).

## 5. Design

### 5.1 Storage

**`run_logs`** (new table, one row per line)

| Column | Notes |
|---|---|
| `id` | `newId("log")` |
| `run_id` | FK `test_runs`, cascade delete |
| `tenant_id` | as other run tables (`runTenantId()`) |
| `time` | when the line was written (the line's own `time`) |
| `source` | `worker` · `api` · `runner` · `browser_use` · `infra` · `web_app` · `target_site` |
| `level` | `trace`…`fatal` |
| `stage` | run lifecycle stage, nullable |
| `component` | the logger's `component` |
| `message` | `msg` |
| `fields` | jsonb: the rest of the redacted record (`err` with stack and causes included) |

Indexes: `(run_id, time, id)` for the view; `(created_at)` or `(time)` for retention.

**Per-run cap:** 20,000 lines (config `RUN_LOG_MAX_LINES`). Past the cap, lines at `warn` and above are still stored,
lower levels are dropped, and one `infra` line records that the cap was reached and how many were dropped. Single
`fields` values longer than 16 KB are truncated with a marker.

**Prompt/response bodies:** one gzipped JSON object per model call
(`{ system, messages, response, error, truncated }`, after the run redactor, i.e. exactly what was sent) in a new
`llm_call_exchanges` table (`bytea`, keyed by `llm_calls.id`). `llm_calls` gets `purpose` (the call's `schemaName`,
e.g. "Act", "Observation") so the view can say *why* the call was made. A failed write logs a warning; the call and
run are unaffected. *(Changed while planning, 2026-11-25: originally artifact storage. `ArtifactStorage` has no read
operation, only browser-fetched signed URLs, and its types and keys feed the member-visible artifact list; Postgres
keeps the crash-safety and no-new-services reasons option 1 was chosen for.)*

**Retention:** the existing daily `retention` job also deletes `run_logs` and `llm_call_exchanges` rows older than
14 days (`RUN_LOG_RETENTION_DAYS`, default 14), in batches, inside its pass time limit. `llm_calls` metadata rows are kept as today (the usage dashboard needs them);
after 14 days a call shows "prompt expired".

### 5.2 Capture, by source

All capture is fire-and-forget into a bounded in-process buffer, flushed in batches (every 500 ms or 200 lines).
A full buffer drops the oldest `debug`/`info` lines first. Insert failures are counted (Prometheus
`run_log_dropped_total{reason}`) and reported once to stdout, never thrown.

| Source | How |
|---|---|
| **worker** | `createLogger` gains an optional `sink`; the worker passes a `RunLogSink` that receives every record that has a `runId` (after enrichment and redaction) and buffers it into `run_logs`. Covers the run jobs, sandbox, preflight, egress, finish, rerun, analyze, reaper, retention and queue-failure lines. |
| **api** | Same sink in the API process. Request logs: an `onResponse` hook writes one line per request whose route has a `:runId` param (method, route, status, duration, principal kind, *not* bodies or headers). Route handlers' own `runId` lines are captured by the sink. |
| **runner** | The runner process has no database access. The Playwright CLI's stderr tail goes back to the worker in the spawn result (the runner-service response for the remote runner), and the worker stores its lines with `source = runner`. |
| **browser_use** | The worker already reads the launcher's bounded stderr diagnostics; each JSON line is stored with `source = browser_use`. No page text or model output (§3). |
| **infra** | Not a process: these are the lines worker/API code writes *about* infrastructure for the run, classified `source = infra` by component or an explicit `source: "infra"` field: sandbox start and preflight result, egress blocked, runner calls and failures, Browser Use container start/exit/OOM/deadline, queue retries, the reaper ending a run (`WORKER_LOST`, expiries), artifact storage failures, the log cap. |
| **web_app** | A client logger in the web app (`window.onerror`, `unhandledrejection`, React error boundary, failed `/api` calls) active on `/runs/[runId]` and its sub-pages posts batches to `POST /v1/test-runs/:runId/client-logs` through the existing proxy. Any signed-in user who can see the run may *send* (so a member's broken page is logged); only admins read. Limits: 50 lines per request, 4 KB per message, 300 lines per run per user, rate-limited like sign-in. |
| **target_site** | The exploration executor and Stagehand explorer add `console` (`error`/`warning` only), `pageerror` and `requestfailed` / HTTP ≥ 400 responses for the tested site, logged through the run logger with `source = target_site` (URL, status, message; no bodies). Captured once for the sandboxed browser (all pages), not per explorer. The Playwright rerun's tested-site console is deferred; only the runner's stderr tail is stored. |

### 5.3 API

- `GET /v1/test-runs/:runId/logs?after=<cursor>&source=&level=&stage=&q=&limit=` → `{ lines, nextCursor }`,
  ordered by `(time, id)`. `requireAdmin`; a run outside the tenant is 404.
- `GET /v1/test-runs/:runId/llm-calls` → the run's calls with metadata and whether the exchange is still available.
- `GET /v1/test-runs/:runId/llm-calls/:callId/exchange` → the decompressed prompt/response JSON, or 410 when expired.
- `POST /v1/test-runs/:runId/client-logs` (§5.2).
- Contracts (zod) for all of these in `@platform/contracts`.

### 5.4 The page

A **Logs** section on the run page, shown only to administrators (`useMe().role === "admin"`), as a tab or a
disclosure next to "Run activity", plus a direct route `/runs/[runId]/logs` that members get a 404 on.

```
Run 7f3a · ERRORED / MODEL_PROVIDER                         [Live ●]
┌ Why it failed ─────────────────────────────────────────────────┐
│ 14:02:11 worker  error  run errored: No API key for Anthropic   │
│          ▸ stack · cause chain   [Jump to line]                 │
└────────────────────────────────────────────────────────────────┘
[ Timeline | Model calls (37) ]
Source: [all ▾]  Level: [warn+ ▾]  Stage: [all ▾]  Search: [____]

Timeline
14:01:02  infra        info   sandbox preflight passed
14:01:05  worker       info   EXPLORING  step 4: click "Add to cart"
14:01:05  target_site  error  console: TypeError: x is undefined  (shop.example/cart)
14:01:06  llm          info   Observation · sonnet · 3.1k→420 tok · 2.4 s   [view prompt]
14:02:11  worker       error  run errored  ▸
```

- **Why it failed** (only for `ERRORED`/`FAILED` runs): the run's terminal error and the last `error`/`fatal`
  lines, each with a link that scrolls the timeline to it.
- **Timeline:** all sources interleaved by time, model calls shown inline as one row each. Filters for source,
  level (default: everything), stage and text. Rows expand to show `fields` as formatted JSON.
- **Model calls:** a table (time, stage, purpose, model, tokens in/out, cost, latency, status) with totals;
  opening a row shows system prompt, messages and response, with copy buttons.
- **Live:** while the run is not terminal, the view polls `logs?after=<cursor>` every 3 s.
- **Download** the run's lines as JSON lines.

## 6. Left to the builder

- Tab versus disclosure placement on the run page, and visual details, within the existing design system.
- Exact component-to-`infra` classification list.
- Batch sizes, timers and index details, within the stated limits.
- Whether the API request-log line uses Fastify's hook or a plugin.
- Migration naming and ordering, test layout.

## 7. Calls made in this design (please check)

1. **Browser Use prompts are not captured**, only its diagnostics, to keep that service's isolation contract (§3).
2. **Secrets in logs and prompts are shown as they are** (no extra masking), consistent with the 2026-10-07
   decision; mitigated by admin-only access and 14-day retention.
3. **Per-run cap 20,000 lines**, warnings and errors always kept.
4. **Members' browsers send frontend errors** for runs they can see; only admins read them.
5. **Model-call metadata is kept beyond 14 days** (usage dashboard); only the prompt/response bodies and log lines
   are deleted.
6. **Polling every 3 s** for the live view rather than a second SSE stream.
7. **Only runs started after release** have logs; older runs show "No logs were recorded for this run."
