# AI Testing Platform

Submit a website URL and a plain-language requirement, confirm the acceptance criteria, watch the run live, and get an evidence-backed report.
Plan: [`docs/ai-testing-platform-implementation-plan.md`](docs/ai-testing-platform-implementation-plan.md).

## Status

**Milestone A (Tasks 0–9) is done**: contracts, database and run state machine, security primitives, artifact storage, demo shop, API (create / get / list / cancel / artifact URLs), live events over SSE, and the worker lifecycle with cancellation, deadlines, and crash recovery.

**Milestone B (Tasks 10–15) is done**: with `LLM_PROVIDER=anthropic` (+ `ANTHROPIC_API_KEY`, optional `LLM_MODEL`, default `claude-sonnet-5`) the worker runs the real discovery engine end to end — the requirement is compiled into acceptance criteria (Task 10, confirmable/editable through the API per D5), the test plan is built with deterministic blocking for missing secrets, missing test data, and destructive actions (Task 12), and the plan is explored with Stagehand v4 inside the browser sandbox: the worker launches its own Chromium behind the egress guard proxy (Task 13, `apps/worker/src/sandbox/`) with the Stagehand runtime extension preloaded (`@platform/stagehand-adapter`, Task 14), then the verifier turns the recorded steps and facts into provisional PASS/FAIL/BLOCKED/INCONCLUSIVE results (Task 15). `LLM_PROVIDER=fake` (the default for local dev and compose) still runs the fully deterministic **fake** engine (`packages/testing-engine/src/orchestrator/fake-stages.ts`), so the Milestone A demo and compose keep working without an API key (Ruling R7).

Generated-test compilation, the sandboxed Playwright rerun, and reconciliation (Tasks 16–18, Milestone C) are still stubs: `generateTest` returns `null` (rerun `UNAVAILABLE`) and the report stage is the fake one, so real runs' reports don't yet carry rerun-confirmed evidence. The web UI is a placeholder until Task 19.

Prompt/model changes are tracked with `pnpm eval requirement-compiler` and `pnpm eval planner` (need `ANTHROPIC_API_KEY`; see `evals/BASELINE.md`). Both eval baselines and the `@live` Stagehand-through-sandbox smoke test (`pnpm test:live`) are **pending an API key** — see `evals/BASELINE.md` for how to record them once one is available.

## Run everything with Docker

Requires Docker Desktop. (`pnpm stack:up` needs Node ≥ 22.18; if Corepack fails with "Cannot find matching keyid", upgrade Node — e.g. `nvm install 22`.)

```bash
pnpm stack:up        # or: docker compose -f infra/compose/docker-compose.yml up -d --build --wait
./scripts/milestone-a-demo.sh
pnpm stack:down
```

The `worker` image bundles Playwright's Chromium (matching the workspace's `playwright-core` pin) and its OS
dependencies, installed under `/ms-playwright` at build time, so the real engine's browser sandbox runs inside
the container with no extra setup.

To run the real engine instead of the fake one, set `LLM_PROVIDER`, `ANTHROPIC_API_KEY` (and optionally
`LLM_MODEL`) before bringing the worker up — either in `infra/compose/.env` or on the command line:

```bash
LLM_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-ant-... docker compose -f infra/compose/docker-compose.yml up -d --wait
./scripts/milestone-b-demo.sh
```

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

```bash
pnpm install
cp .env.example .env            # then adjust
pnpm infra:up                   # postgres, redis, s3, demo-shop
pnpm db:migrate
pnpm --filter @platform/api dev
pnpm --filter @platform/worker dev
pnpm --filter @platform/web dev
```

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
apps/api                     Fastify API: auth, runs, cancel, criteria (get/update/confirm), SSE events, artifact URLs
apps/worker                  BullMQ jobs (analyze-run, execute-run, reap) + the browser sandbox
apps/worker/src/sandbox      egress guard proxy, Chromium launcher, navigation guard (Task 13)
apps/web                     Next.js UI (placeholder until Task 19)
packages/contracts           Zod schemas: the single source of truth
packages/config              env schema (validated at start-up)
packages/db                  Drizzle schema, SQL migrations, repositories, state machine
packages/security            URL/IP policy, redaction, secret vault, destructive-action policy
packages/storage             artifact storage (local, S3)
packages/event-bus           event publisher, Redis fan-out, queue names
packages/llm                 provider-neutral LLM client (redaction, retries, LlmCall records), Anthropic adapter
packages/stagehand-adapter    Stagehand v4 explorer, ClientLLM bridge, the runtime extension (Task 14)
packages/testing-engine       orchestrator + engine stages: requirement compiler, planner, exploration, verifier (Tasks 10-15) real; generateTest/runTest/report still fake until Milestone C
evals                         `pnpm eval <suite>` harness and cases; BASELINE.md records scores
tests/integration             real-Chromium/sandbox/Stagehand-adapter tests + the `@live` Stagehand smoke test
tests/fixtures/demo-shop      deterministic test target
spikes/stagehand-v4           Task 0 spike code (see docs/spikes/stagehand-v4.md)
scripts/milestone-a-demo.sh   Milestone A demo (fake engine, lifecycle + SSE + cancel + crash recovery)
scripts/milestone-b-demo.sh   Milestone B demo (real engine: criteria confirmation, planner blocking, exploration)
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
