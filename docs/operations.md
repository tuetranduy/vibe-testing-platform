# Operations

How to run the AI Testing Platform V1 in production: topology, network policy, key rotation,
metrics and alerts, logs, retention, and the release checks.

## Topology

| Service | Talks to | Ports |
|---|---|---|
| `web` (Next.js) | `api` only, over `API_URL`, with the API token added server-side | 3000 |
| `api` (Fastify) | PostgreSQL, Redis, S3 | 3001: `/healthz`, `/metrics`, `/v1/*` |
| `worker` × N | PostgreSQL, Redis, S3, the model providers (Anthropic, Gemini, DeepSeek); runs each run's sandboxed Chromium and Playwright runner as child processes | 9464: `/metrics` (`WORKER_METRICS_PORT`, `0` disables it) |
| PostgreSQL | — | runs, events, criteria, results, artifacts metadata, encrypted run secrets, and the model settings: default model and the provider API keys saved in Settings (encrypted, long-lived) |
| Redis | — | BullMQ queues `runs`, `maintenance` (reaper) and `retention`; pub/sub for live events and cancel signals |
| S3-compatible storage | — | screenshots, traces, videos (compose uses rclone's S3 server; any S3 store works) |

The demo shop (`tests/fixtures/demo-shop`) is a development and test target only.

Scale by adding workers: each takes `WORKER_CONCURRENCY` runs at a time. The maintenance jobs (the reaper every
30 s, retention daily) are BullMQ job schedulers, so exactly one process runs each tick however many are deployed.
The reaper is consumed by the workers **and the API**, so it keeps running when every worker is down — which is when
it matters: a run whose worker died stops heartbeating and is ended `ERRORED / WORKER_LOST` 60–90 s later, whether or
not another worker is up. Retention runs in the workers only, on its own queue, so a slow artifact store never
delays the reaper.

The reaper also ends the two waiting states when nobody acts: a run awaiting criteria confirmation, or awaiting the
choice of a suggested test ("Choose what to test", `AWAITING_SELECTION`), for longer than `CONFIRMATION_TTL_HOURS`
is cancelled (`CONFIRMATION_EXPIRED` / `SELECTION_EXPIRED`) and its secrets are purged. A `SURVEYING` run whose
worker stops heartbeating ends `ERRORED / WORKER_LOST` like any active run.

The API and the worker port 9464 must stay on a private network. `/metrics` and `/healthz` are unauthenticated,
and the web app's proxy never forwards either.

Give the API and every worker the same `LLM_*` variables and provider keys (compose's `x-app-env` does). The API
decides from them which model a new test uses and whether its provider has a key; the worker then builds that
run's model client from the key saved in Settings or its own environment key. If they differ, a test can be
accepted and then end `ERRORED / MODEL_PROVIDER` ("No API key for Anthropic: add one in Settings"). Keys saved in
Settings avoid the question: both read them from the database.

## Users and sign-in (V1.1)

The web app requires sign-in. Accounts live in PostgreSQL (`users`, scrypt password hashes); a sign-in opens a
session whose token the web server keeps in an httpOnly cookie (`platform_session`, `SameSite=Lax`, `Secure` over
https) and forwards to the API as `X-Session-Token`. Only a SHA-256 of the token is stored (`user_sessions`).

- **First administrator.** Set `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` on the API: while the tenant
  has no user at all, the API creates that administrator at start. Production refuses the example password
  (`admin-password-change-me`). After that, administrators add people under **Settings → Users**; the variables
  can stay set (they do nothing once a user exists) or be removed.
- **Roles.** Members see and act on their own runs only (others' runs answer 404). Administrators see everyone's
  runs, and manage users, AI model settings, saved credentials and the exploration cache. The tenant always keeps
  one enabled administrator.
- **Sessions.** `SESSION_TTL_HOURS` (default 12) from sign-in, not sliding. Signing out, a password change (the
  user's other sessions), a reset by an administrator and disabling an account end sessions at once. Each person
  sees their live sessions (browser, sign-in and last-active times) on `/account` and can sign out one of them or
  every other one.
- **More organizations (tenants).** `/login` signs in to `DEFAULT_TENANT_ID`; `/login?org=<id>` to another tenant.
  Add one, with its first administrator, with
  `TENANT_ADMIN_PASSWORD=… pnpm --filter @platform/api create-tenant <id> "<name>" <admin e-mail>`; that administrator
  adds the others. A tenant's people, runs, suites, settings and keys are its own; every run's child rows carry the
  tenant too (D6).
- **Failed sign-ins.** 10 per e-mail address in 15 minutes, then `429` for the rest of the window (a Redis counter,
  shared by every API instance).
- **The service token.** `API_TOKEN` still authenticates every API call (the web server holds it). A call with
  no session header acts as the service: unrestricted, like V1. Scripts and the E2E suite use it; never expose it.
- **Audit.** `audit_events` records sign-ins (a failed one names a hash of the typed address, not the address),
  sign-outs, user changes, settings changes, credential profile changes, cache clears and every reveal of a
  secret-bearing artifact, with the user who did it.

When the only administrator is locked out, promote another account in the database (the bootstrap variables only
act while there is no user at all), then reset the administrator's password from Settings → Users:

```sql
UPDATE users SET role = 'admin', disabled_at = NULL WHERE email = 'someone@example.com';
```

## Suites, schedules and API tokens (V1.2)

**Suites** rerun saved Playwright tests with no model call; each run of a suite is a *suite run* whose tests are
ordinary reruns (`test_runs.suite_run_id`). A running suite run takes **one** slot of
`MAX_ACTIVE_RUNS_PER_TENANT`, whatever its size; its tests are all queued at once and `WORKER_CONCURRENCY` bounds how
many run together (KI-038). A suite run settles when its last test ends: in the worker, on read, and in the reaper's
sweep (every 30 s), so a crash between never leaves one `RUNNING`.

**Schedules** (`suite_schedules`) fire suites at the times of a five-field cron expression in a time zone:

- `SCHEDULE_MIN_INTERVAL_MINUTES` (default 15): the least time between two firings of one schedule, checked over its
  next 20 firings. At most 5 schedules per suite and 50 per tenant.
- Each enabled schedule has a BullMQ job scheduler on the `suite-schedules` queue, keyed by the schedule's id. The
  table is the truth: the API resyncs every scheduler when it starts ("suite schedules synced" in the log) and
  removes the ones whose schedule is gone or disabled. **The API processes consume the queue**, so schedules fire
  only while an API is up. A firing taken more than 15 minutes after it was due (no API was up then) is skipped
  (`skipped_late`), not run late; the next one runs on time.
- A firing runs as the schedule's creator with the suite's saved credentials only. It is skipped while that
  schedule's previous suite run is going and fails (without running) when the creator is disabled or gone, a secret
  is missing, or the tenant is at its cap. Each outcome is on the schedule (`lastOutcome`, `lastError`) and in
  `audit_events` (`schedule.fired`, `schedule.skipped`, `schedule.failed`).

**API tokens** (`api_tokens`) let CI and scripts run suites and read results as a person, limited to the token's
scopes. Only the SHA-256 of a token is stored; it is shown once. Disabling a person revokes their tokens; an
administrator can revoke anyone's under Settings → API tokens. Token creation and revocation are audited
(`token.created`, `token.revoked`).

- External callers use the **web app**, never the API: `https://<web host>/api/ext/v1/…` with `Authorization: Bearer
  tap_…`. The web server forwards the token as `X-Api-Token` next to the service `API_TOKEN`, on an allow-list of
  the token-reachable endpoints only, without cookies. **Add the public host CI uses to `WEB_ALLOWED_HOSTS`.**
- Limits: 120 requests per token and minute and 600 per token and hour, counted by the API in Redis (shared by every
  instance; `429` with `Retry-After`, passed through by the web app).
- The GitHub Action (`.github/actions/run-suite`) and the CLI (`integrations/platform-client/cli.mjs`) are described,
  with an example workflow, in [`integrations/README.md`](../integrations/README.md).

## Recordings and live-site reads (V1.3)

- **ffmpeg.** Exploration videos are encoded by the ffmpeg Playwright installs next to Chromium
  (`playwright-core install chromium`, as the worker image does); set `FFMPEG_PATH` to use another. Without one the
  worker logs "exploration video skipped" and records the trace only. Encoding runs one ffmpeg per exploring run
  (VP8, 1 Mbit/s, one thread): size worker CPU for it, or turn video off per run (`options.recordVideo: false`).
- **Storage.** Videos and traces are ordinary artifacts (`VIDEO`, `TRACE`) with the run's retention; a run with
  secrets stores them `SECRET_BEARING` (shorter retention, reveal required), and every trace is scrubbed of the
  secret values before upload. Expect a few MB per run for each; the rerun now keeps its video and trace on success
  too unless the run turns them off.
- **Temporary files.** Recordings are written under the OS temp directory (`recording-<runId>-*`) and deleted when
  the explore stage ends, whatever its outcome.
- **Live-site reads.** The analysis (and a fully blocked run's evidence snapshot) opens the run's browser sandbox
  without Stagehand — same egress proxy, navigation guard and allowed hosts as exploration — so the worker network
  policy below applies unchanged. It adds up to 45 s to `ANALYSIS_TIMEOUT_SECONDS` (default 120 s) worth of work;
  raise that timeout if analyses of slow sites time out.

## Worker network policy

Browsers reach targets only through the per-run egress proxy: exploration's Chromium runs with
`--proxy-server=<proxy>` and `--proxy-bypass-list=<-loopback>`, and the Playwright rerun gets its own proxy. The
proxy resolves each host itself, refuses non-public addresses (including a public name that re-resolves to a
private one — DNS rebinding), and publishes an `egress.blocked` event for the site's own attempts. The navigation
guard also keeps top-level navigation on the target's hosts.

Enforce the same boundary in the network (defense in depth — it catches anything that bypasses the proxy):

- **Allow** the worker to reach: its PostgreSQL, Redis and S3 endpoints; the model providers its tests use
  (`api.anthropic.com:443` for Claude models, `generativelanguage.googleapis.com:443` for Gemini models, `api.deepseek.com:443` for
  DeepSeek models — each test picks its model in Settings or the new-test form, so allow every provider in use); DNS; and
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
   environment (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`) need nothing.
5. Reopen.

With `NODE_ENV=production` the API and the worker refuse to start with a placeholder key (the all-zero example from
`.env.example` and compose, or any key with fewer than 16 distinct byte values) or with the development `API_TOKEN`
(`dev-api-token-change-me-please`). Generate the key with
`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.

A run still pending with secrets encrypted under the old key ends `ERRORED` ("Run could not be started by the
worker") when a worker with the new key picks it up. It never runs with a wrong secret. Keep the key in a secret
manager, never in compose files or images.

Provider API keys saved in Settings are encrypted with the same key but are long-lived, so a drain does not clear
them. Until one is entered again, every test on that provider ends `ERRORED / MODEL_PROVIDER` with "The saved
Anthropic key can't be read (was SECRETS_ENCRYPTION_KEY rotated?): enter it again in Settings" (Gemini: "Google
Gemini"; DeepSeek: "DeepSeek"), even when the environment also holds a key for it: a saved key takes precedence, so remove it in
Settings to fall back to the environment's.

## Metrics

| Metric | Labels | Exported by | Counts |
|---|---|---|---|
| `test_runs_total` | `lifecycle`, `verdict` (`none` when absent) | worker, API | runs reaching COMPLETED / ERRORED / CANCELLED (the API counts runs it ends itself: cancel before a worker holds them, enqueue failures) |
| `test_run_duration_seconds` | `stage` | worker, API | histogram of time spent in each lifecycle stage, observed when the run leaves it (from when it entered it, so `QUEUED` includes the queue wait) by whichever process moves it on: the API for `AWAITING_CONFIRMATION` → `PLANNING`, `AWAITING_SELECTION` → `ANALYZING_REQUIREMENT` and its cancels, the reaper for the runs it ends. Runs created without a requirement add `SURVEYING` and `AWAITING_SELECTION` |
| `queue_depth` | `queue` (`runs`) | API | jobs waiting to be picked up (absent for a scrape when Redis cannot answer) |
| `active_worker_runs` | — | worker | analyze / execute jobs in progress |
| `browser_sessions_active` | — | worker | open exploration sandboxes and running rerun processes |
| `llm_requests_total` | `stage`, `model`, `status` | worker | model calls (`SUCCESS`, `INVALID_OUTPUT`, `PROVIDER_ERROR`, `CANCELLED`) |
| `llm_tokens_total` | `stage`, `model`, `direction` (`input` / `output`) | worker | model tokens |
| `llm_cost_usd_total` | `stage`, `model` | worker | estimated model cost |
| `stagehand_cache_hits_total` | — | worker | exploration steps served from Stagehand's cache (always 0 today: caching is Browserbase-only) |
| `egress_blocked_total` | `reason` | worker | connections the egress proxies denied (Chromium's own background services excluded) |
| `reconciliation_disagreements_total` | — | worker | criteria whose discovery result and rerun disagreed (`DISCOVERY_RERUN_DISAGREE`) |
| `runs_reaped_total` | `reason` (`WORKER_LOST`, `TIMEOUT`, `NEVER_STARTED`, `CONFIRMATION_EXPIRED`, `SELECTION_EXPIRED`) | worker, API | runs the reaper ended (whichever process ran that tick) |
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
(`runId`), and errors by `component`. The API's HTTP access log is Fastify's (pino), with the `authorization`,
`cookie`, `x-session-token` and `x-api-token` headers redacted and request bodies never logged.

## Retention

A daily `retention` job (its own queue) deletes expired artifacts, the object first and then its row.
`expires_at` is set when an artifact is stored: `SECRET_BEARING` after `SECRET_ARTIFACT_RETENTION_DAYS` (7),
`STANDARD` after `ARTIFACT_RETENTION_DAYS` (30). A failed delete is logged and retried on the next pass. A pass
stops after an hour, even in the middle of a store call that does not return ("retention pass reached its time
limit" in the log), and leaves the rest to the next pass; S3 calls also fail after 5 s without a connection or 30 s
of silence. As a backstop, configure an S3 lifecycle rule that expires objects some time after the longest retention
(e.g. 45 days).

The same daily pass deletes exploration cache entries (V1.1, `exploration_cache`) no run has reused for 30 days.
Entries hold selectors and accessible names, never page values; an administrator can clear a tenant's cache at
once from Settings (`DELETE /v1/exploration-cache`, audited), e.g. after a site redesign.

Suites, their schedules and API tokens (V1.2) are kept until someone deletes them (a revoked or expired token stays
listed). Deleting a suite deletes its schedules; its suite runs, like every run, are kept.

Saved test data sets and credential profiles (V1.1) are kept until someone deletes them. A run takes its own copy
when it is created; a profile's copy is purged with the run's other secrets when the run ends.

## Release checks

CI (`.github/workflows/ci.yml`, GitHub Actions) runs typecheck, `pnpm test` (with the S3 tests), `pnpm
test:integration` and `pnpm test:e2e` on every push and pull request; nightly, the live E2E suite on Gemini; on
demand (`workflow_dispatch` with `live-gate`), the release gate. The live jobs need a `GEMINI_API_KEY` repository
secret from a billing-enabled project. The runners are Ubuntu 24.04, whose AppArmor denies the unprivileged user
namespaces Chromium's sandbox needs; the workflow lifts that (`kernel.apparmor_restrict_unprivileged_userns=0`).


- `pnpm test`, `pnpm test:integration` and `pnpm test:e2e` (CI mode: scripted model and explorer, deterministic)
  on every change, with `pnpm infra:up` running.
- `./scripts/e2e-live-gate.sh` before a release: the E2E suite against the real model and Stagehand, green three
  times in a row (needs `ANTHROPIC_API_KEY`, `LLM_PROVIDER=gemini` with `GEMINI_API_KEY`, or `LLM_PROVIDER=deepseek` with
  `DEEPSEEK_API_KEY`; the calls are billed).
