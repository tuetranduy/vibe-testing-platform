# Operations

How to run the AI Testing Platform V1 in production: topology, network policy, key rotation,
metrics and alerts, logs, retention, and the release checks.

## Topology

| Service | Talks to | Ports |
|---|---|---|
| `web` (Next.js) | `api` only, over `API_URL`, with the API token added server-side | 3000 |
| `api` (Fastify) | PostgreSQL, Redis, S3 | 3001: `/healthz`, `/metrics`, `/v1/*` |
| `worker` × N | PostgreSQL, Redis, S3, the model providers (Anthropic, Gemini); runs each run's sandboxed Chromium and Playwright runner as child processes | 9464: `/metrics` (`WORKER_METRICS_PORT`, `0` disables it) |
| PostgreSQL | — | runs, events, criteria, results, artifacts metadata, encrypted run secrets, and the model settings: default model and the provider API keys saved in Settings (encrypted, long-lived) |
| Redis | — | BullMQ queues `runs`, `maintenance` (reaper) and `retention`; pub/sub for live events and cancel signals |
| S3-compatible storage | — | screenshots, traces, videos (compose uses rclone's S3 server; any S3 store works) |

The demo shop (`tests/fixtures/demo-shop`) is a development and test target only.

Scale by adding workers: each takes `WORKER_CONCURRENCY` runs at a time. The maintenance jobs (the reaper every
60 s, retention daily) are BullMQ job schedulers, so exactly one worker runs each tick however many are deployed.
Retention has its own queue, so a slow artifact store never delays the reaper.

The API and the worker port 9464 must stay on a private network. `/metrics` and `/healthz` are unauthenticated,
and the web app's proxy never forwards either.

Give the API and every worker the same `LLM_*` variables and provider keys (compose's `x-app-env` does). The API
decides from them which model a new test uses and whether its provider has a key; the worker then builds that
run's model client from the key saved in Settings or its own environment key. If they differ, a test can be
accepted and then end `ERRORED / MODEL_PROVIDER` ("No API key for Anthropic: add one in Settings"). Keys saved in
Settings avoid the question: both read them from the database.

## Worker network policy

Browsers reach targets only through the per-run egress proxy: exploration's Chromium runs with
`--proxy-server=<proxy>` and `--proxy-bypass-list=<-loopback>`, and the Playwright rerun gets its own proxy. The
proxy resolves each host itself, refuses non-public addresses (including a public name that re-resolves to a
private one — DNS rebinding), and publishes an `egress.blocked` event for the site's own attempts. The navigation
guard also keeps top-level navigation on the target's hosts.

Enforce the same boundary in the network (defense in depth — it catches anything that bypasses the proxy):

- **Allow** the worker to reach: its PostgreSQL, Redis and S3 endpoints; the model providers its tests use
  (`api.anthropic.com:443` for Claude models, `generativelanguage.googleapis.com:443` for Gemini models — each test
  picks its model in Settings or the new-test form, so allow both unless one provider is never used); DNS; and
  public internet on TCP 80/443 for targets.
- For Gemini models, use an API key (Settings or `GEMINI_API_KEY`) from a billing-enabled Google project: on the
  Gemini API's free tier, Google may use prompts and responses (here: redacted page content and screenshots) to
  improve its products.
- **Deny**: cloud metadata (`169.254.169.254/32`, `fd00:ec2::254/128`), RFC 1918 (`10.0.0.0/8`, `172.16.0.0/12`,
  `192.168.0.0/16`), CGNAT (`100.64.0.0/10`), link-local and ULA ranges (`169.254.0.0/16`, `fe80::/10`, `fc00::/7`),
  and every other internal service, including databases other than the worker's own.
- The API needs no internet egress (target URLs are validated with DNS only).
- `TARGET_PRIVATE_ALLOWLIST` (testing private hosts) is refused when `NODE_ENV=production`.
- Chromium keeps its own sandbox on (exploration's browser and the rerun's). It needs Linux user namespaces, which
  Docker's default seccomp profile denies, so run the worker with `infra/seccomp/worker.json` (compose does): Docker's
  default plus user, PID and network namespaces for `clone` / `unshare`, no extra capability. Never `--no-sandbox`
  or `SYS_ADMIN`. The host must allow unprivileged user namespaces (see `infra/seccomp/README.md`); with the real
  engine, the worker's start-up log says "browser sandbox preflight passed" or why it failed.
- Run the worker with an init process as PID 1 (compose: `init: true`), so the helpers of the browsers it kills are
  reaped.

## Rotating `SECRETS_ENCRYPTION_KEY`

Secrets (e.g. a login password) are AES-256-GCM encrypted with this key and bound to their run and name. They
exist only while a run is active: they are purged when the run ends, and the reaper purges any that a crash left
behind. There is no key id, so rotation is a drain, not a re-encryption:

1. Stop new runs: take the web UI offline, or block `POST /v1/test-runs` at the reverse proxy.
2. Wait until no run holds a secret, or cancel the ones that do:

   ```sql
   SELECT run_id FROM run_secrets WHERE purged_at IS NULL;
   ```

3. Deploy the new key to the API **and** every worker at the same time.
4. Enter again every provider key saved in Settings → AI providers ("Save key"). Keys that come from the
   environment (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`) need nothing.
5. Reopen.

A run still pending with secrets encrypted under the old key ends `ERRORED` ("Run could not be started by the
worker") when a worker with the new key picks it up. It never runs with a wrong secret. Keep the key in a secret
manager, never in compose files or images.

Provider API keys saved in Settings are encrypted with the same key but are long-lived, so a drain does not clear
them. Until one is entered again, every test on that provider ends `ERRORED / MODEL_PROVIDER` with "The saved
Anthropic key can't be read (was SECRETS_ENCRYPTION_KEY rotated?): enter it again in Settings" (Gemini: "Google
Gemini"), even when the environment also holds a key for it: a saved key takes precedence, so remove it in
Settings to fall back to the environment's.

## Metrics

| Metric | Labels | Exported by | Counts |
|---|---|---|---|
| `test_runs_total` | `lifecycle`, `verdict` (`none` when absent) | worker, API | runs reaching COMPLETED / ERRORED / CANCELLED (the API counts runs it ends itself: cancel before a worker holds them, enqueue failures) |
| `test_run_duration_seconds` | `stage` | worker, API | histogram of time spent in each lifecycle stage, observed when the run leaves it (from when it entered it, so `QUEUED` includes the queue wait) by whichever process moves it on: the API for `AWAITING_CONFIRMATION` → `PLANNING` and its cancels, the reaper for the runs it ends |
| `queue_depth` | `queue` (`runs`) | API | jobs waiting to be picked up (absent for a scrape when Redis cannot answer) |
| `active_worker_runs` | — | worker | analyze / execute jobs in progress |
| `browser_sessions_active` | — | worker | open exploration sandboxes and running rerun processes |
| `llm_requests_total` | `stage`, `model`, `status` | worker | model calls (`SUCCESS`, `INVALID_OUTPUT`, `PROVIDER_ERROR`, `CANCELLED`) |
| `llm_tokens_total` | `stage`, `model`, `direction` (`input` / `output`) | worker | model tokens |
| `llm_cost_usd_total` | `stage`, `model` | worker | estimated model cost |
| `stagehand_cache_hits_total` | — | worker | exploration steps served from Stagehand's cache (always 0 today: caching is Browserbase-only) |
| `egress_blocked_total` | `reason` | worker | connections the egress proxies denied (Chromium's own background services excluded) |
| `reconciliation_disagreements_total` | — | worker | criteria whose discovery result and rerun disagreed (`DISCOVERY_RERUN_DISAGREE`) |
| `runs_reaped_total` | `reason` (`WORKER_LOST`, `TIMEOUT`, `NEVER_STARTED`, `CONFIRMATION_EXPIRED`) | worker | runs the reaper ended |
| `artifact_upload_failures_total` | — | worker | failed artifact uploads |

Both processes also export Node.js default metrics (heap, event loop lag, GC).

### Alert suggestions

```promql
# A worker died mid-run (page).
increase(runs_reaped_total{reason="WORKER_LOST"}[15m]) > 0

# Runs keep hitting the hard deadline.
increase(runs_reaped_total{reason="TIMEOUT"}[1h]) > 3

# Egress blocks spike: 5x the same window yesterday (none yesterday counts as 0), and above an absolute
# floor of 0.1/s, so a quiet yesterday does not turn a single block into an alert.
sum(rate(egress_blocked_total[10m])) > 5 * (sum(rate(egress_blocked_total[10m] offset 1d)) or vector(0))
  and sum(rate(egress_blocked_total[10m])) > 0.1

# Cost per run above $0.50 over the last hour.
sum(increase(llm_cost_usd_total[1h])) / clamp_min(sum(increase(test_runs_total[1h])), 1) > 0.50

# Backlog: runs waiting and nobody working on them.
queue_depth{queue="runs"} > 10                                       # for: 10m
queue_depth{queue="runs"} > 0 and on() sum(active_worker_runs) == 0  # for: 5m

# The artifact store is failing.
increase(artifact_upload_failures_total[15m]) > 0

# Discovery and rerun disagree often (flaky targets or locator drift).
increase(reconciliation_disagreements_total[1d])
  / clamp_min(sum(increase(test_runs_total{lifecycle="COMPLETED"}[1d])), 1) > 0.2

# Model provider trouble.
sum(rate(llm_requests_total{status="PROVIDER_ERROR"}[10m])) / clamp_min(sum(rate(llm_requests_total[10m])), 1e-9) > 0.2
```

## Logs

Both processes write one JSON object per line to stdout (`level`, `time`, `component`, `msg`, fields). Every line a
worker writes about a run it is processing carries `runId`, `tenantId`, `stage` and `component`, whichever code logged
it (including a run it skips or cannot start). Lines about a run written from outside its job (reaper, retention,
the queue's job-failure handler) carry `runId` and whatever else is at hand. Two layers of redaction run on every line:
key-based (`password`, `token`, `authorization`, `cookie`, …) and the run's own redactor, which masks the run's
secret values in any encoded form, including inside error messages. An `err` field carries the error's name, message,
`code`, stack and `cause` chain (up to five causes), redacted like the rest of the line; the `run errored` line
carries the error that ended the run. Useful filters: all lines of one run
(`runId`), and errors by `component`. The API's HTTP access log is Fastify's (pino), with the `authorization` and
`cookie` headers redacted and request bodies never logged.

## Retention

A daily `retention` job (its own queue) deletes expired artifacts, the object first and then its row.
`expires_at` is set when an artifact is stored: `SECRET_BEARING` after `SECRET_ARTIFACT_RETENTION_DAYS` (7),
`STANDARD` after `ARTIFACT_RETENTION_DAYS` (30). A failed delete is logged and retried on the next pass. A pass
stops after an hour, even in the middle of a store call that does not return ("retention pass reached its time
limit" in the log), and leaves the rest to the next pass; S3 calls also fail after 5 s without a connection or 30 s
of silence. As a backstop, configure an S3 lifecycle rule that expires objects some time after the longest retention
(e.g. 45 days).

## Release checks

- `pnpm test`, `pnpm test:integration` and `pnpm test:e2e` (CI mode: scripted model and explorer, deterministic)
  on every change, with `pnpm infra:up` running.
- `./scripts/e2e-live-gate.sh` before a release: the E2E suite against the real model and Stagehand, green three
  times in a row (needs `ANTHROPIC_API_KEY`, or `LLM_PROVIDER=gemini` with `GEMINI_API_KEY`; the calls are billed).
