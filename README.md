# AI Testing Platform

Submit a website URL and a plain-language requirement, confirm the acceptance criteria, watch the run live, and get an evidence-backed report.
Plan: [`docs/ai-testing-platform-implementation-plan.md`](docs/ai-testing-platform-implementation-plan.md).

## Status

**Milestone A (Tasks 0–9) is done**: contracts, database and run state machine, security primitives, artifact storage, demo shop, API (create / get / list / cancel / artifact URLs), live events over SSE, and the worker lifecycle with cancellation, deadlines, and crash recovery.

**Milestone B (Tasks 10–15) is implemented**: with `LLM_PROVIDER=anthropic` (+ `ANTHROPIC_API_KEY`, optional `LLM_MODEL`, default `claude-sonnet-5`) the worker runs the real discovery engine — the requirement is compiled into acceptance criteria (Task 10, confirmable/editable through the API per D5), the test plan is built with deterministic blocking for missing secrets, missing test data, and destructive actions (Task 12), and the plan is explored with Stagehand v4 inside the browser sandbox: the worker launches its own Chromium behind the egress guard proxy (Task 13, `apps/worker/src/sandbox/`) with the Stagehand runtime extension preloaded (`@platform/stagehand-adapter`, Task 14), then the verifier turns the recorded steps and facts into provisional PASS/FAIL/BLOCKED/INCONCLUSIVE results (Task 15). `LLM_PROVIDER=fake` (the default for local dev and compose) still runs the fully deterministic **fake** engine (`packages/testing-engine/src/orchestrator/fake-stages.ts`), so the Milestone A demo and compose keep working without an API key (Ruling R7).

**Milestone C (Tasks 16–18) is implemented**: after verification the real engine compiles the discovered golden path into a Playwright test (Task 16, `packages/testing-engine/src/compiler`: `run.spec.ts` + `helpers.ts` + `run-data.json`, semantic locators, every run value in the JSON file, secrets read from `SECRET_*` environment variables; the source passes an allowlist AST guard and typechecks against `@playwright/test`), then reruns it in a sandbox (Task 17): a Playwright child process in a per-run workspace under `RUNNER_WORKSPACE_DIR`, with an environment allow-list (only this run's `SECRET_*`, `PATH`, `PLAYWRIGHT_BROWSERS_PATH`, and `TMPDIR` pointed into the workspace) and its own egress proxy (same private allowlist as exploration). Trace, screenshot and video are kept only when the rerun fails; traces are scrubbed of every secret value (plain, URL-encoded, base64, JSON/HTML-escaped) before upload, and every artifact of a run with secrets is `SECRET_BEARING`. Reconciliation (Task 18, `src/reconciliation`) combines each criterion's provisional result with its rerun outcome: a discovery PASS/FAIL the rerun confirms has `verdictSource: PLAYWRIGHT_RERUN`; a disagreement is `INCONCLUSIVE / DISCOVERY_RERUN_DISAGREE`; without a rerun outcome, PASS/FAIL stands (`EXPLORATION_ONLY`) only when every referenced fact was read from the DOM, else `INCONCLUSIVE / UNVERIFIED_EVIDENCE` — so no PASS exists without deterministic evidence. `GET /v1/test-runs/:runId/report` returns the reconciled `TestReport` (`packages/contracts/src/report.ts`): per criterion the status, `verdictSource`, `rerunOutcome`, the provisional status, `expected` / `actual`, `evidenceArtifactIds`, `relatedStepIds` (and an AI note for semantic criteria); the summary (incl. `confirmedByRerun`), the verdict, the generated test's source, the rerun's status and duration, diagnostics and LLM usage. It answers `409 REPORT_NOT_READY` until the run is terminal, and a `partial: true` report for `ERRORED` / `CANCELLED` runs. Artifacts are fetched through `GET /v1/test-runs/:runId/artifacts/:artifactId/url` (`?reveal=true` for `SECRET_BEARING` ones). The web UI is a placeholder until Task 19.

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
pnpm --filter @platform/web dev
```

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
- Redis tests use `TEST_REDIS_URL` (default `redis://localhost:6379`).
- S3 storage tests run only when `S3_TEST_ENDPOINT` is set (see `packages/storage/README.md`).
- Demo shop tests: `cd tests/fixtures/demo-shop && npx playwright install chromium && npx playwright test -c playwright.config.ts`.
- `pnpm test:integration` and `pnpm test:live` run through the top-level `vitest.config.ts` projects (`integration`, `live`); `test:live` includes the Stagehand-through-sandbox smoke test (`tests/integration/stagehand-smoke.live.test.ts`) and any `*.live.test.ts` under `packages/**/src`.

## Layout

```text
apps/api                     Fastify API: auth, runs, cancel, criteria (get/update/confirm), SSE events, artifact URLs, report
apps/worker                  BullMQ jobs (analyze-run, execute-run, reap) + the browser sandbox
apps/worker/src/sandbox      egress guard proxy, Chromium launcher, navigation guard (Task 13), Playwright runner child process (Task 17)
apps/web                     Next.js UI (placeholder until Task 19)
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
