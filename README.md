# AI Testing Platform

Submit a website URL and a plain-language requirement, confirm the acceptance criteria, watch the run live, and get an evidence-backed report.
Plan: [`docs/ai-testing-platform-implementation-plan.md`](docs/ai-testing-platform-implementation-plan.md).

## Status

**Milestone A (Tasks 0–9) is done**: contracts, database and run state machine, security primitives, artifact storage, demo shop, API (create / get / list / cancel / artifact URLs), live events over SSE, and the worker lifecycle with cancellation, deadlines, and crash recovery.

**Milestone B (Tasks 10–15) is implemented**: with `LLM_PROVIDER=anthropic` (+ `ANTHROPIC_API_KEY`, optional `LLM_MODEL`, default `claude-sonnet-5`) the worker runs the real discovery engine — the requirement is compiled into acceptance criteria (Task 10, confirmable/editable through the API per D5), the test plan is built with deterministic blocking for missing secrets, missing test data, and destructive actions (Task 12), and the plan is explored with Stagehand v4 inside the browser sandbox: the worker launches its own Chromium behind the egress guard proxy (Task 13, `apps/worker/src/sandbox/`) with the Stagehand runtime extension preloaded (`@platform/stagehand-adapter`, Task 14), then the verifier turns the recorded steps and facts into provisional PASS/FAIL/BLOCKED/INCONCLUSIVE results (Task 15). `LLM_PROVIDER=fake` (the default for local dev and compose) still runs the fully deterministic **fake** engine (`packages/testing-engine/src/orchestrator/fake-stages.ts`), so the Milestone A demo and compose keep working without an API key (Ruling R7).

**Milestone C (Tasks 16–18) is implemented**: after verification the real engine compiles the discovered golden path into a Playwright test (Task 16, `packages/testing-engine/src/compiler`: `run.spec.ts` + `helpers.ts` + `run-data.json`, semantic locators, every run value in the JSON file, secrets read from `SECRET_*` environment variables; the source passes an allowlist AST guard and typechecks against `@playwright/test`), then reruns it in a sandbox (Task 17): a Playwright child process in a per-run workspace under `RUNNER_WORKSPACE_DIR`, with an environment allow-list (only this run's `SECRET_*`, `PATH`, `PLAYWRIGHT_BROWSERS_PATH`, and `TMPDIR` pointed into the workspace) and its own egress proxy (same private allowlist as exploration). Trace, screenshot and video are kept only when the rerun fails; traces are scrubbed of every secret value (plain, URL-encoded, base64, JSON/HTML-escaped) before upload, and every artifact of a run with secrets is `SECRET_BEARING`. Reconciliation (Task 18, `src/reconciliation`) combines each criterion's provisional result with its rerun outcome: a discovery PASS/FAIL the rerun confirms has `verdictSource: PLAYWRIGHT_RERUN`; a disagreement is `INCONCLUSIVE / DISCOVERY_RERUN_DISAGREE`; without a rerun outcome, PASS/FAIL stands (`EXPLORATION_ONLY`) only when every referenced fact was read from the DOM, else `INCONCLUSIVE / UNVERIFIED_EVIDENCE` — so no PASS exists without deterministic evidence. `GET /v1/test-runs/:runId/report` returns the reconciled `TestReport` (`packages/contracts/src/report.ts`): per criterion the status, `verdictSource`, `rerunOutcome`, the provisional status, `expected` / `actual`, `evidenceArtifactIds`, `relatedStepIds` (and an AI note for semantic criteria); the summary (incl. `confirmedByRerun`), the verdict, the generated test's source, the rerun's status and duration, diagnostics and LLM usage. It answers `409 REPORT_NOT_READY` until the run is terminal, and a `partial: true` report for `ERRORED` / `CANCELLED` runs. Artifacts are fetched through `GET /v1/test-runs/:runId/artifacts/:artifactId/url` (`?reveal=true` for `SECRET_BEARING` ones).

**Milestone D (Tasks 19–20, the web UI) is implemented and its gate was demonstrated on 2026-09-26** (see [Milestone D demo](#milestone-d-demo)). **Task 19** (`apps/web`, Next.js): the new-test form (`/runs/new`: URL, requirement, environment, optional test data and masked secrets, collapsed advanced options; `422 TARGET_NOT_ALLOWED` shown on the URL field, `429 TOO_MANY_ACTIVE_RUNS` as a banner; secret values are cleared from the page as soon as a submit is sent), and the run page (`/runs/<runId>`), which follows the lifecycle: analyzing → criteria review (edit / remove / "Confirm and start", with ambiguous and AI-judged criteria highlighted) → live progress (stages, timeline of the server's template messages, latest screenshot; `SECRET_BEARING` screenshots only after "Reveal") → completed / cancelled / errored. Live progress comes from the SSE stream; after a disconnect the client reconnects with `Last-Event-ID`, so no event is lost or shown twice. **Task 20** adds the final report and the run history: `/` opens the history (`/runs`: created time, target host, requirement preview, result, duration; "Load more" pages through `GET /v1/test-runs` with its cursor), and a finished run's page shows its report — for COMPLETED the verdict, summary cards (criteria counts, how many PASS/FAIL results the Playwright rerun confirmed, duration, estimated model cost), one expandable row per criterion (status as icon + label + color, the reason in plain language, "Confirmed by rerun" / "Not confirmed by rerun", the AI note kept apart from the status; details: requirement text → expected → actual → related steps → evidence → diagnostics), the generated Playwright test (read-only, syntax-highlighted, with the criteria it could not compile and why) and every stored artifact; for ERRORED / CANCELLED a partial report (lifecycle, error category, the technical message behind a disclosure, and whatever was recorded). Artifact types and sensitivity come from the run's `artifact.created` events; `SECRET_BEARING` artifacts stay hidden until "Reveal (may contain entered credentials)".

**The browser only talks to the web app.** `apps/web/app/api/[...path]/route.ts` proxies an allow-list of the V1 endpoints to `API_URL` and adds `Authorization: Bearer $API_TOKEN` on the server (both read from the web server's environment at request time; the token never reaches the browser). It drops the browser's own `Authorization` / `Cookie` headers, forwards only `content-type`, `accept`, `idempotency-key` and `last-event-id`, streams SSE unbuffered, and rejects `POST` / `PUT` requests whose `Origin` isn't one of the web app's hosts. **V1 has no end-user authentication** (single tenant, D6): anyone who can reach the web app can create, confirm, cancel and view runs, and reveal secret-bearing screenshots. Only expose it to trusted users (a private network, VPN, or an authenticating reverse proxy in front of it).

**`WEB_ALLOWED_HOSTS` (web server env, default `localhost:3000,127.0.0.1:3000`; compose sets the same).** A comma-separated list of the `host[:port]` names the UI is served on, exactly as browsers send them in `Host` (no port for 80/443). The proxy answers `403` to every request — reads included — whose `Host` isn't listed, and to every request marked `Sec-Fetch-Site: cross-site`; `POST` / `PUT` must also carry an `Origin` on a listed host. This is what stops DNS rebinding: a page on `evil.example:3000` whose name is re-pointed at your web app has a matching `Origin` and `Host`, but its `Host` isn't on the list. **Operators must list every hostname they serve the UI on** (e.g. `WEB_ALLOWED_HOSTS=testing.example.com`), and a reverse proxy in front of the web app must pass the original `Host` through (`X-Forwarded-Host` is ignored, since a page can set it).

**First run against the real provider: 2026-09-26** (`claude-sonnet-5`). The eval baselines are recorded in `evals/BASELINE.md`; `pnpm test:live` and `scripts/milestone-b-demo.sh` (local API + real-engine worker) pass. The integration and live test projects transpile TypeScript the way `tsx` does (esbuild `keepNames`), because functions sent into the browser with `evaluate` fail there with "`__name` is not defined" when they declare a named inner function.

**Real exploration and the Playwright rerun do not run in the Docker worker yet.** Chromium's own sandbox needs Linux user namespaces, which Docker's default container confinement (seccomp profile and capability set) denies, so in the compose `worker` container Chromium aborts with "No usable sandbox!" and exploring runs end `ERRORED / BROWSER_PROVIDER` (with a real provider configured, the worker's start-up preflight logs the failure). The rerun's Chromium (launched by `@playwright/test` in the runner child process) keeps its sandbox on as well (`chromiumSandbox: true` in the generated `playwright.config.js`; Playwright would otherwise add `--no-sandbox`), so the same caveat applies to it: in the container it cannot start, the rerun ends `ERRORED`, and criteria fall back to their exploration evidence (`EXPLORATION_ONLY` / `UNVERIFIED_EVIDENCE`). How to allow it is an open security decision: a seccomp profile that permits user namespaces for the worker (preferred), `cap_add: SYS_ADMIN` (broad), or Chromium's `--no-sandbox` (not recommended: the browser runs untrusted pages). Until then, run the real engine with a **local worker** — see [Real engine (Milestone B)](#real-engine-milestone-b).

## Run everything with Docker

Requires Docker Desktop. (`pnpm stack:up` needs Node ≥ 22.18; if Corepack fails with "Cannot find matching keyid", upgrade Node — e.g. `nvm install 22`.)

```bash
pnpm stack:up        # or: docker compose -f infra/compose/docker-compose.yml up -d --build --wait
./scripts/milestone-a-demo.sh
pnpm stack:down
```

The compose stack runs the **fake** engine (`LLM_PROVIDER=fake`). The `worker` image bundles Playwright's
Chromium (matching the workspace's `playwright-core` pin) and its OS dependencies under `/ms-playwright`, but
Chromium can't start its sandbox in the container yet (see Status), so use a local worker for the real engine.

| Service | URL |
|---|---|
| API | http://localhost:3001 (bearer token `dev-api-token-change-me-please`) |
| Web | http://localhost:3000 |
| Demo shop (test target) | http://localhost:4000 — use `http://demo-shop:4000/` as `targetUrl` |
| S3 artifact store | http://localhost:9000 (s3admin / s3admin-secret) |

Override secrets in `infra/compose/.env` (`API_TOKEN`, `SECRETS_ENCRYPTION_KEY`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, …).

Signed artifact URLs (screenshots, traces, videos) are opened by your browser, which can't resolve the compose-internal
`http://s3:9000`. The compose `api` therefore sets `S3_PUBLIC_ENDPOINT=http://localhost:9000` (override it in
`infra/compose/.env` if the stack is reached under another host name). Optional everywhere: when set, S3 read URLs
are presigned against it instead of `S3_ENDPOINT`; it must reach the same server and bucket (Ruling R54).

**Images built before Milestone D run the old UI** (and an api without `S3_PUBLIC_ENDPOINT`): rebuild with
`pnpm stack:up` (it passes `--build`) to get the new `web` and `api`.
The defaults are for local use only.

Try it by hand:

```bash
TOKEN=dev-api-token-change-me-please
curl -s -X POST localhost:3001/v1/test-runs -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"targetUrl":"http://demo-shop:4000/","requirement":"A user can add a product to the cart.","options":{"autoConfirmCriteria":true}}'
curl -N localhost:3001/v1/test-runs/<runId>/events -H "authorization: Bearer $TOKEN"
```

## Develop locally

Requires **Node ≥ 22.18** (Stagehand v4's minimum; `engines.node` in `package.json` enforces it), pnpm 10
(`corepack enable`), and Docker for Postgres / Redis / MinIO.

The real engine's browser sandbox (Task 13) launches Playwright's own Chromium directly (not via
`npx playwright test`), so install it once per machine:

```bash
pnpm --filter @platform/worker exec playwright-core install chromium
```

Environment variables added by the Playwright rerun (Task 17), both optional absolute paths: `RUNNER_WORKSPACE_DIR`
(per-run workspaces `<dir>/<runId>/`, deleted after each rerun; default `<os tmpdir>/platform-runs`, `/work/runs` in the
Docker image) and `RUNNER_NODE_MODULES_DIR` (the `node_modules` holding `@playwright/test` that workspaces link to;
default: the one `@platform/testing-engine` resolves).

The apps don't read `.env` themselves; export it into each terminal first:

```bash
pnpm install
cp .env.example .env            # then adjust
pnpm infra:up                   # postgres, redis, s3, demo-shop
set -a; . ./.env; set +a        # in every terminal below
pnpm db:migrate
pnpm --filter @platform/api dev
pnpm --filter @platform/worker dev
pnpm --filter @platform/web dev   # needs API_URL and API_TOKEN (from .env); open http://localhost:3000
```

**The UI against a local API.** The web app reads only `API_URL`, `API_TOKEN` and `WEB_ALLOWED_HOSTS`, at request
time, on the server (`apps/web/app/api/[...path]/route.ts`); `API_TOKEN` must equal the API's. Any port works, as long
as `WEB_ALLOWED_HOSTS` lists the host and port you open:

```bash
cd apps/web
API_URL=http://localhost:3011 API_TOKEN=<the API's token> WEB_ALLOWED_HOSTS=localhost:3002 pnpm exec next dev -p 3002   # http://localhost:3002
```

With `S3_ENDPOINT=http://localhost:9000` (as in `.env.example`) signed URLs already work from the browser;
set `S3_PUBLIC_ENDPOINT` only if the API reaches S3 under a name the browser can't.

### Real engine (Milestone B)

The working route today: compose for the infrastructure, and the API and the worker on your machine. The API
runs locally too because the compose API only allowlists `demo-shop:4000`, a name a local worker can't resolve.

```bash
pnpm install
pnpm --filter @platform/worker exec playwright-core install chromium   # once per machine
pnpm infra:up                   # postgres, redis, s3, demo-shop only
# If the full stack is up (pnpm stack:up), stop its api and worker: the fake worker would take the jobs
# and the compose API holds port 3001.
docker compose -f infra/compose/docker-compose.yml stop api worker
cp .env.example .env            # allowlists localhost:4000 (the demo shop) for dev
```

```bash
# terminal 1
set -a; . ./.env; set +a
pnpm db:migrate
pnpm --filter @platform/api dev

# terminal 2
set -a; . ./.env; set +a
LLM_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-ant-... pnpm --filter @platform/worker dev
# expect "using the real test engine", "browser sandbox preflight passed" and "rerun runner preflight passed" in its log

# terminal 3
./scripts/milestone-b-demo.sh   # targets http://localhost:4000/ by default
```

The demo asserts each outcome and exits non-zero on a mismatch: run 1 stops at `AWAITING_CONFIRMATION`,
is confirmed through the API and ends `COMPLETED`; run 2 (login without the password secret) has a criterion
`BLOCKED / MISSING_SECRET`; run 3 (delete the account) has one `BLOCKED / DESTRUCTIVE_ACTION_NOT_AUTHORIZED`.
It refuses to continue if the fake engine answers (it recognises the fake engine's fixed criteria).

### Milestone C demo

Same route as Milestone B (compose infrastructure, local API, local real-engine worker), then:

```bash
./scripts/milestone-c-demo.sh   # targets http://localhost:4000/ by default; two live runs, auto-confirmed
```

It asserts, exiting non-zero on the first mismatch (and stopping with an explanation if the fake engine answers):

1. **Healthy shop** (add iPhone 17 Pro to the cart, then open the cart): the run ends `COMPLETED`; `test.generated` and
   `playwright.completed` were published; the report has `generatedTest.source`, `summary.confirmedByRerun ≥ 1`, and
   every PASS criterion has a `verdictSource` and references only facts whose last `fact.observed` reading is
   `DOM_VERIFIED` (never a PASS on model-extracted facts). The reconciled report JSON is printed.
2. **`?bug=empty_cart` + a login with the password secret**: the criterion "the cart lists iPhone 17 Pro" ends
   `FAIL / PLAYWRIGHT_RERUN` with non-empty `expected`, `actual`, `evidenceArtifactIds` and `relatedStepIds`; every
   artifact of the run is `SECRET_BEARING`; the artifact URL route refuses the rerun `TRACE` without `reveal=true`
   (403), and the trace downloaded with it contains the password in none of its forms (plain, URL- and
   form-encoded, base64 / base64url) while it does record the password field's fill, with the value `[REDACTED]`.

**Live run, 2026-09-26: not completed.** The first run ended `ERRORED / MODEL_PROVIDER` at `ANALYZING_REQUIREMENT`:
the Anthropic API answered 400 "Your credit balance is too low", so no run could reach the generated test. The
script's non-LLM checks were exercised separately: its report and evidence checks against earlier runs' reports
through the API, and its trace checks against a real scrubbed rerun trace (the password fill recorded as
`"value":"[REDACTED]"`, no form of the password present). Re-run the script once the provider account has credit.

### Milestone D demo

The gate: new test → criteria review → live progress → final report → artifacts → history, with no progress lost on
reconnect, a criterion-centric report that shows how each result was confirmed, and the API token never in the browser.
With the full stack (after `pnpm stack:up`) open http://localhost:3000 and use `http://demo-shop:4000/` as the URL;
with a local API and worker (fake engine) and `next dev`, use `http://localhost:4000/`. Then:

1. **New test**: URL, a requirement, optionally a test-data row and a secret row (the value is masked) → "Start test".
2. **Criteria review**: edit a criterion ("Edit" → "Save" makes a new revision), remove one if you like, "Confirm and
   start". Warnings from the confirm (ambiguous or AI-judged criteria) show in the "Criteria confirmed" note; the fake
   engine's criteria are never ambiguous, so it shows none.
3. **Live progress**: the stage list, the timeline and the latest screenshot update from the event stream. Stop the
   API mid-run and start it again: "Connection lost — reconnecting…" shows, and the timeline resumes without gaps or
   duplicates. "Cancel run" → "Yes, cancel run" ends it with a partial report.
4. **Final report**: the verdict and summary cards, one row per criterion with its status and how it was confirmed
   ("Confirmed by rerun", or why not); expand a row for requirement → expected → actual → related steps → evidence →
   diagnostics. Below: the generated Playwright test, "All evidence" (`STANDARD` files load; `SECRET_BEARING` ones
   need "Reveal"), and the run activity.
5. **History**: `/runs` lists every run, newest first ("Load more" after 50).

The fake engine stores no screenshots or traces (only the real engine and the Playwright rerun do).

**Verified run, 2026-09-26** (Ruling R53: an isolated local stack from this branch on the compose Postgres, S3 and demo
shop: API on :3011 and a `LLM_PROVIDER=fake` worker, both on Redis DB 1 so no other worker could take the jobs, and
`next dev` on :3002; `FAKE_ENGINE_STEP_DELAY_MS=4000`–`6000` to give the live view time). Checked in the browser, at
1280 px and 375 px (no horizontal page scroll):
- every step above, on runs against `http://localhost:4000/` (secret row masked; AC-2 edited to revision 2; stages
  and timeline live; report with both criteria "Pass · Confirmed by rerun", details expanded; generated test; history
  of 22 runs, one page, so "Load more" did not appear); a cancelled run's partial report ("Exploring website" marked
  Stopped); and an earlier real-engine run's errored partial report ("Model provider error", technical details
  collapsed);
- artifacts against real stored objects: a throwaway script (not in the repo) stored a real screenshot (`STANDARD`)
  and a real Playwright trace (`SECRET_BEARING`) for one run through `@platform/storage` and `ArtifactRepository` and
  published their `artifact.created` events. The screenshot showed live and in the report from a signed URL on the
  `S3_PUBLIC_ENDPOINT` host; the trace's URL was not requested until "Reveal", then with `?reveal=true` (without it
  the API answers `403 REVEAL_REQUIRED`), and its link downloaded the stored bytes;
- reconnect: the API was killed (`SIGKILL`) during exploration. The stream broke after event 10, the client retried
  with `Last-Event-ID: 10` (502 from the proxy while the API was down), and after the restart received 11–29. The
  rendered timeline had 29 entries, equal one for one to the API's `/events` backfill (1–29). The same after a
  graceful restart (`SIGTERM`), which surfaced a fix: open SSE streams now end when the API shuts down;
- the token: none of the served pages (including the inline RSC data), the 16 JS chunks the pages load, the DOM,
  storage, cookies, request URLs, proxy response headers or `apps/web/.next` contained the API token.

The fake engine's generated test is now stored like the real one's, so its report shows the generated-test viewer.

## Tests

```bash
pnpm test              # all unit + DB/Redis tests (needs `pnpm infra:up`)
pnpm test:integration   # tests/integration/**: real-Chromium sandbox + Stagehand adapter tests, no LLM
pnpm test:live          # @live only: needs a real Chromium + ANTHROPIC_API_KEY; excluded from `pnpm test`
pnpm typecheck
pnpm eval requirement-compiler   # needs ANTHROPIC_API_KEY; scores a suite against the real model
pnpm eval planner                # same, for the planner prompt
```

- DB tests clone a migrated template database per test file. They use `TEST_DATABASE_URL`, which defaults to the compose Postgres (`postgresql://platform:platform@localhost:5432/platform`). The role needs `CREATEDB`.
- Redis tests use `TEST_REDIS_URL` (default `redis://localhost:6379`). Some worker tests create real BullMQ queues, so
  while a dev or compose worker is running on the same Redis, point the tests at another database index
  (e.g. `TEST_REDIS_URL=redis://localhost:6379/2`) so that worker can't take their jobs.
- S3 storage tests run only when `S3_TEST_ENDPOINT` is set (see `packages/storage/README.md`).
- Demo shop tests: `cd tests/fixtures/demo-shop && npx playwright install chromium && npx playwright test -c playwright.config.ts`.
- `pnpm test:integration` and `pnpm test:live` run through the top-level `vitest.config.ts` projects (`integration`, `live`); `test:live` includes the Stagehand-through-sandbox smoke test (`tests/integration/stagehand-smoke.live.test.ts`) and any `*.live.test.ts` under `packages/**/src`.

## Layout

```text
apps/api                     Fastify API: auth, runs, cancel, criteria (get/update/confirm), SSE events, artifact URLs, report
apps/worker                  BullMQ jobs (analyze-run, execute-run, reap) + the browser sandbox
apps/worker/src/sandbox      egress guard proxy, Chromium launcher, navigation guard (Task 13), Playwright runner child process (Task 17)
apps/web                     Next.js UI: new test, criteria review, live progress (Task 19); report, run history (Task 20); server-side API proxy in app/api/[...path]
packages/contracts           Zod schemas: the single source of truth
packages/config              env schema (validated at start-up)
packages/db                  Drizzle schema, SQL migrations, repositories, state machine
packages/security            URL/IP policy, redaction, secret vault, destructive-action policy
packages/storage             artifact storage (local, S3)
packages/event-bus           event publisher, Redis fan-out, queue names
packages/llm                 provider-neutral LLM client (redaction, retries, LlmCall records), Anthropic adapter
packages/stagehand-adapter    Stagehand v4 explorer, ClientLLM bridge, the runtime extension (Task 14)
packages/testing-engine       orchestrator + engine stages: requirement compiler, planner, exploration, verifier (Tasks 10-15), test compiler, Playwright rerun + evidence, reconciliation + report (Tasks 16-18)
evals                         `pnpm eval <suite>` harness and cases; BASELINE.md records scores
tests/integration             real-Chromium/sandbox/Stagehand-adapter tests + the `@live` Stagehand smoke test
tests/fixtures/demo-shop      deterministic test target
spikes/stagehand-v4           Task 0 spike code (see docs/spikes/stagehand-v4.md)
scripts/milestone-a-demo.sh   Milestone A demo (fake engine, lifecycle + SSE + cancel + crash recovery)
scripts/milestone-b-demo.sh   Milestone B demo (real engine, local worker: criteria confirmation, planner blocking, exploration)
scripts/milestone-c-demo.sh   Milestone C demo (real engine, local worker: generated test, sandboxed rerun, scrubbed trace, reconciled report)
```

## Deviations from the plan

- **Drizzle ORM instead of Prisma.** Prisma's CLI downloads a native engine from `binaries.prisma.sh`, which was unreachable in the build environments. Drizzle is pure TypeScript and gives the same Postgres tables, enums, and constraints. Migrations are plain SQL in `packages/db/migrations` (`pnpm --filter @platform/db db:generate` after editing `schema.ts`).
- **rclone's S3 server instead of MinIO** in Docker Compose: MinIO images are no longer available on Docker Hub. Production can use any S3-compatible store.
- **Zod pinned to 4.4.3** because Stagehand v4 pins it (Task 0 finding).
- **Only the Anthropic provider exists in V1.** `LLM_PROVIDER=openai` makes the worker fail at start-up. The model is set with `LLM_MODEL`.
- **Engine error classes live in `@platform/contracts`** (re-exported by `@platform/testing-engine`) so `@platform/llm` can throw `ModelProviderError` / `ContractError` / `CancelledError` without depending on the engine.
- **`analyze` returns a draft; the orchestrator persists revision 1** (the plan's `compileRequirement` signature returns the stored requirement).
- **`docs/ai-testing-platform-architecture.md`** is referenced by the plan but wasn't in the repo, so it hasn't been updated.
- **Stagehand caching is unavailable in this deployment.** Stagehand v4's action cache is Browserbase-only (Task 0 spike, Ruling R21); self-hosted Chromium has no equivalent, so `llm.cacheHit` is always `null` and every exploration step re-calls the model, even on a re-run of the same page.
- **Stagehand's OTel telemetry can't be disabled** (Task 0 spike caveat 3, Ruling R22): the egress proxy silently denies its fixed endpoint instead (no `egress.blocked` event, since it isn't caused by the site under test).
- **Milestone C (Tasks 16–18):**
  - **No navigation guard in the rerun** (Ruling R31). Exploration's Chromium has a CDP navigation guard that keeps it on the target's hosts; the rerun's Chromium is launched by `@playwright/test` and has only its own egress proxy (same private allowlist as exploration). Off-domain navigation during a rerun is therefore limited only by the proxy's public/private address policy: a private address needs `TARGET_PRIVATE_ALLOWLIST`, but any public host is reachable.
  - **A rerun that fails on its own is rerun `ERRORED`, not run `ERRORED`** (Ruling R41): a workspace, spawn, proxy or browser-launch failure, a crashed runner, unreadable results or an exhausted rerun budget ends the rerun `ERRORED` (criteria whose `[AC-n]` step completed keep their outcome, the rest `NOT_REACHED`), and the run still completes on its exploration evidence. The cause is in the worker log; only a cancel or the run's hard deadline ends the run itself. The rerun budget is capped by the time left before the run's deadline, minus a reserve for the report.
  - **A test-generation failure skips the rerun** (Ruling R45): a compiler exception, or the guard rejecting the source after redaction, is logged and the run continues without a generated test (every criterion's rerun outcome `UNAVAILABLE`).
  - **The API depends on `@platform/testing-engine`, through its `./reporting` subpath only** (Rulings R36, R43), so the report route reuses the worker's pure report assembler without loading Stagehand. The rerun's per-criterion outcomes are persisted in the `playwright.completed` event (`perCriterion`) rather than in new columns; partial reports read them from there.
  - **Unbuilt images:** `infra/runner/Dockerfile` (the runner base image) and the root `Dockerfile`'s worker-target changes (`RUNNER_WORKSPACE_DIR`, `procps`) have not been built or run; and the Docker worker cannot start a sandboxed Chromium yet (see Status).
