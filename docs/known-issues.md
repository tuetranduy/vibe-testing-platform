# Known issues

Outstanding defects, gaps and open decisions after Milestone E (recorded 2026-09-27). Each has an ID to refer
to when it is picked up; mark it resolved here (with the commit) rather than deleting it.

Severity: **High** blocks the V1 release gate or can hide a real failure; **Medium** is a correctness or
operability gap a user or operator will hit; **Low** is polish, test hygiene or a misleading edge case.

KI-002 to KI-017 were resolved on 2026-09-27 (branch `fix/known-issues`); each entry names its commit. KI-001 and
KI-018 to KI-020 are open.

| ID | Severity | Area | Summary | Status |
|---|---|---|---|---|
| KI-001 | High | Release gate | Live E2E gate (3 consecutive green runs) has not been run | Open |
| KI-002 | High | Deployment | Chromium's sandbox cannot start in the compose worker | Resolved `03dcc07` |
| KI-003 | Medium | Metrics | `test_run_duration_seconds` attributes the first stage of each job wrongly | Resolved `d7b2606` |
| KI-004 | Medium | Metrics | `runs_reaped_total` undercounts when a reaper pass fails midway | Resolved `068b4f8` |
| KI-005 | Medium | Compose | Worker metrics port published on all interfaces; fixed host port blocks scaling | Resolved `4868c9a` |
| KI-006 | Medium | E2E coverage | CI destructive spec never exercises the executor's DOM-level guard | Resolved `24f7a80` |
| KI-007 | Low | Logging | Run log scope is released outside a `finally` in `dispose()` | Resolved `6239203` |
| KI-008 | Low | Logging | Logger prints shared (non-cyclic) references as `"[Circular]"`; errors lose `stack` / `cause` | Resolved `a0c544e` |
| KI-009 | Low | E2E coverage | Cancel spec's runner-gone / `runnerDir` checks always pass | Resolved `0e5a916` |
| KI-010 | Low | E2E coverage | Blocked spec: dead `STANDARD`-artifact loop; secret check looks only for the raw value | Resolved `e4ebc28` |
| KI-011 | Low | Docs | Egress-spike alert fires on any block when the previous day had none | Resolved `5e5eb11` |
| KI-012 | Low | Tests | `vitest.config.ts` comment says runs go one at a time; E2E worker runs two | Resolved `868763c` |
| KI-013 | Low | Tests | `createTestApi` casts `extra.queue` to `FakeQueue` without checking | Resolved `c11483a` |
| KI-014 | Low | Retention | A retention pass has no time limit and the S3 client has no request timeout | Resolved `14ed9e9` |
| KI-015 | Low | Docs | Spec checkboxes for Tasks 21–22 are unticked (spec file is read-only) | Resolved `04ca3c7` |
| KI-016 | Env | Dev machine | Stale sandbox profile in `$TMPDIR` fails `sandbox-preflight.test.ts` | Resolved `6d7bcf5` + machine cleanup |
| KI-017 | Env | Dev machine | Default shell Node 22.13 is below `engines` and its Corepack is broken | Resolved (machine setup) |
| KI-018 | Medium | LLM provider | The Gemini provider has only been run live on a free-tier key | Open |
| KI-019 | Low | Cost metrics | Gemini 3.6–3.8 Flash prices double on 2027-01-01 | Open |
| KI-020 | Medium | Exploration | A Stagehand step that times out holds up the next step's model call | Open |

---

## KI-001 — Live E2E gate has not been run
- **Severity:** High (Milestone E acceptance: "live suite green 3 times in a row").
- **Where:** `scripts/e2e-live-gate.sh`, `tests/e2e/platform-*.spec.ts`, `tests/e2e/platform-injection.spec.ts`.
- **What:** Live mode (`E2E_MODE=live`: real model + Stagehand) has never run end to end; there was no
  `ANTHROPIC_API_KEY` in the implementation environment. The prompt-injection spec (Task 21 step 6) runs only in
  live mode.
- **Risk:** Some specs identify criteria by check kind (`numeric_compare`, `collection_contains`); a real model
  may phrase criteria differently. Loosen only assertions that pin model wording, never platform guarantees
  (`verdictSource`, blocking reasons, secret hygiene). The two cases added for KI-006 and KI-009 are CI-only
  (they depend on the scripted plan), so the live suite runs the same cases as before.
- **To close:** `pnpm infra:up && ANTHROPIC_API_KEY=… ./scripts/e2e-live-gate.sh`, then record the date and result in
  README "Status", and tick Task 21 step 6 in the plan.

## KI-002 — Chromium's sandbox cannot start in the compose worker
- **Severity:** High for deployment (pre-existing; see README "Status").
- **What:** Docker's default seccomp profile denies the user namespaces Chromium's sandbox needs, so real
  exploration and the Playwright rerun fail in the `worker` container (`ERRORED / BROWSER_PROVIDER`). The E2E suite
  therefore runs the worker as a local process.
- **To close:** decide the open security question — a seccomp profile allowing user namespaces for the worker
  (preferred), `cap_add: SYS_ADMIN`, or `--no-sandbox` (not recommended) — then run the E2E suite against the
  compose worker.
- **Resolved** (`03dcc07`): the preferred option. `infra/seccomp/worker.json` is Docker's default profile with
  `clone` and `unshare` allowed to create user, PID and network namespaces (mount, UTS, IPC and cgroup stay denied;
  no extra capability), derived by `infra/seccomp/derive-worker-profile.mjs`; the compose `worker` uses it, plus an
  init process that reaps browser helpers. Both Chromium builds in the image start sandboxed (renderers in their
  own user, PID and network namespaces). `pnpm test:e2e:compose` runs the E2E suite with the API and worker as
  containers of the compose services: 13 passed, 1 skipped (live only); with Docker's default profile its PASS
  spec ends `ERRORED`. Hosts must still allow unprivileged user namespaces (`infra/seccomp/README.md`).

## KI-003 — `test_run_duration_seconds` attributes the first stage of each job wrongly
- **Severity:** Medium.
- **Where:** `apps/worker/src/run-context.ts` (`stageStartedAt` seeded with `now()` when the context is built).
- **What:** Each analyze job records a near-zero `QUEUED` sample (not the real queue wait); each execute job records
  a near-zero `PLANNING` sample, making `PLANNING` bimodal; `AWAITING_CONFIRMATION` is never observed.
- **Fix:** seed from the run's last lifecycle change time (e.g. a `lifecycleChangedAt` / `updatedAt` column), or skip
  the first observation of each job.
- **Resolved** (`d7b2606`): the run context seeds the clock from `run.lifecycleChangedAt`, and every transition
  now times the stage it ends, whichever process makes it: the API exports the same histogram (confirm →
  `AWAITING_CONFIRMATION`, cancels, enqueue failures), and the reaper and a run the worker cannot start observe it
  too.

## KI-004 — `runs_reaped_total` undercounts when a reaper pass fails midway
- **Severity:** Medium.
- **Where:** `apps/worker/src/jobs/reap.ts` (the counter is incremented once, after the whole pass).
- **What:** If the pass throws after reaping some runs, `test_runs_total` already counts them but `runs_reaped_total`
  does not.
- **Fix:** increment `runsReaped` per run, next to the `testRuns` increment.
- **Resolved** (`068b4f8`): as suggested, with a test that fails a later sweep's query.

## KI-005 — Worker metrics port published on all interfaces; fixed host port blocks scaling
- **Severity:** Medium (dev compose only).
- **Where:** `infra/compose/docker-compose.yml` (`ports: ["9464:9464"]` on `worker`).
- **What:** Exposes unauthenticated metrics on every host interface (the ops doc says the port must stay private),
  and a fixed host port makes `docker compose up --scale worker=N` fail.
- **Fix:** `127.0.0.1:9464:9464`, or drop the mapping and scrape over the compose network.
- **Resolved** (`4868c9a`): `127.0.0.1::9464` — loopback only, a random host port per replica
  (`docker compose port --index N worker 9464`). Two replicas started side by side, each on its own loopback port.

## KI-006 — CI destructive spec never exercises the executor's DOM-level guard
- **Severity:** Medium (test gap on a safety control).
- **Where:** `tests/e2e/support/scenarios.ts` (deletion scenario: `destructive: true`, description contains "Delete").
- **What:** The planner's deterministic blocking stops the plan first, so `executor.enforcePolicy` — the guard that
  checks the actual element before clicking, which is what protects against prompt injection — never runs in CI.
- **Fix:** add a scenario whose planned step is `destructive: false` with a neutral description (e.g. "Click the
  button in the danger zone") that resolves to `[data-testid="delete-account"]`; expect
  `BLOCKED / DESTRUCTIVE_ACTION_NOT_AUTHORIZED` and zero delete clicks.
- **Resolved** (`24f7a80`): as suggested; the spec also checks the plan blocked nothing. With the element check
  disabled, it fails and the old deletion spec still passes.

## KI-007 — Run log scope is released outside a `finally` in `dispose()`
- **Severity:** Low.
- **Where:** `apps/worker/src/run-context.ts` (`releaseLog?.()` at the end of `dispose()`).
- **What:** If `unwatch()` (or anything before the release) throws, the run's log scope stays registered for the
  life of the process.
- **Fix:** wrap the body of `dispose()` in `try { … } finally { releaseLog?.(); }`.
- **Resolved** (`6239203`): as suggested; the run's decrypted secrets are cleared in the `finally` too.

## KI-008 — Logger prints shared references as `"[Circular]"`; errors lose `stack` / `cause`
- **Severity:** Low.
- **Where:** `packages/config/src/logger.ts` (`stringify`, `serializeError`).
- **What:** The `seen` set marks any repeated object, so `{ a: x, b: x }` logs `b` as `"[Circular]"`.
  `serializeError` keeps only `name`, `message`, `code`, which makes ERRORED runs harder to debug.
- **Fix:** track the ancestor stack instead of every seen object; include a (redacted) `stack` and a serialized
  `cause` chain.
- **Resolved** (`a0c544e`): as suggested (up to five causes, a looping chain ends in `"[Circular]"`). The
  "run errored" and "could not be started" lines logged the message as a string; they now log the error itself.
  The testing engine's degraded-path log lines (`redactedCause`, Ruling R45) still carry name and message only.

## KI-009 — Cancel spec's runner-gone / `runnerDir` checks always pass
- **Severity:** Low.
- **Where:** `tests/e2e/platform-cancel.spec.ts`.
- **What:** The run is cancelled during `EXPLORING`, before any Playwright runner or workspace exists, so those
  assertions are vacuous. Runner teardown on cancel is covered only by unit tests.
- **Fix:** add a case that cancels during `RUNNING_PLAYWRIGHT` (e.g. a slow page only on the rerun path) and assert
  the runner process and workspace are gone.
- **Resolved** (`0e5a916`): a second case slows every page (`?slow=1500`, so the rerun lasts seconds), waits until
  the runner's processes and workspace exist, cancels, and asserts both are gone; the `EXPLORING` case keeps only
  its browser checks. With the workspace removal disabled, the new case fails. CI mode only (`8d91d08`).

## KI-010 — Blocked spec: dead loop; secret check looks only for the raw value
- **Severity:** Low.
- **Where:** `tests/e2e/platform-blocked.spec.ts`.
- **What:** The loop over `STANDARD` artifacts never runs (the next assertion requires all artifacts to be
  `SECRET_BEARING`). The absence checks search only for the raw secret, not its URL-encoded, base64 or
  JSON-escaped forms, which the redactor also handles.
- **Fix:** drop or repurpose the loop; check every encoded form, as `compiled-rerun.test.ts` does for traces.
- **Resolved** (`e4ebc28`): the loop is replaced by asserting no artifact is anything but `SECRET_BEARING`; DB rows,
  events and logs are checked for every form in `secretForms()` (raw, URL- and form-encoded, base64 padded /
  unpadded / URL-safe, JSON- and HTML-escaped).

## KI-011 — Egress-spike alert fires on any block when the previous day had none
- **Severity:** Low.
- **Where:** `docs/operations.md` (egress-spike PromQL).
- **Fix:** add an absolute floor, e.g. `… > 5 * … and sum(rate(egress_blocked_total[10m])) > 0.1`.
- **Resolved** (`5e5eb11`): the floor, and `or vector(0)` so a day with no series compares against 0.

## KI-012 — Misleading comment about E2E run concurrency
- **Severity:** Low.
- **Where:** `vitest.config.ts` (`e2e` project comment) vs `tests/e2e/support/stack.ts` (`WORKER_CONCURRENCY: "2"`).
- **Fix:** correct the comment (spec files run one at a time; the worker may run two jobs).
- **Resolved** (`868763c`).

## KI-013 — `createTestApi` casts `extra.queue` without checking
- **Severity:** Low.
- **Where:** `apps/api/src/test-support.ts`.
- **Fix:** type `extra.queue` as `FakeQueue`, or return the queue as `RunQueue`.
- **Resolved** (`c11483a`): `extra.queue` is typed `FakeQueue`; a `@ts-expect-error` test keeps any other queue out.

## KI-014 — Retention pass has no time limit; S3 client has no request timeout
- **Severity:** Low (retention now has its own queue, so it can no longer block the reaper).
- **Where:** `apps/worker/src/jobs/retention.ts`, `packages/storage/src/s3-storage.ts`.
- **What:** A hung S3 call can stall a retention pass indefinitely, delaying the next day's pass.
- **Fix:** a per-pass deadline in `retentionJob`, and request/connection timeouts on the S3 client.
- **Resolved** (`14ed9e9`): a pass stops after an hour (`passTimeoutMs`), even inside a store call that does not
  return, and reports `stoppedEarly`; the S3 client fails a request after 5 s without a connection or 30 s of
  socket inactivity (an idle limit, so large uploads that keep moving are not cut off).

## KI-015 — Spec checkboxes for Tasks 21–22 are unticked
- **Severity:** Low (documentation).
- **Where:** `docs/ai-testing-platform-implementation-plan.md` is read-only on disk, so it was not edited; the
  README records Milestone E status and deviations instead.
- **To close:** make the file writable and tick Task 21 steps 1–5, 7–9 and Task 22 steps 1–6 (step 6 of Task 21
  after KI-001).
- **Resolved** (`04ca3c7`): ticked; the file was made writable for the edit only and is read-only again.

## KI-016 — Stale sandbox profile in `$TMPDIR` fails `sandbox-preflight.test.ts`
- **Severity:** Environment (this machine only).
- **What:** `platform-sandbox-preflight-h4hlZ1`, created 2026-09-26 12:57 by an earlier run, makes the "leaves no
  profile behind" assertion fail. The suite passes 29/29 with a fresh `TMPDIR`.
- **To close:** `rm -rf "$TMPDIR"/platform-sandbox-preflight-h4hlZ1`.
- **Resolved:** the profile belonged to a Chromium that was still running, orphaned since 2026-09-26 12:57 (its
  process group, 8 processes); it was stopped and the profile removed. The test (`6d7bcf5`) now checks only for
  profiles its own preflight leaves, so a leftover from an interrupted process cannot fail it.

## KI-017 — Default shell Node is below the repo's minimum
- **Severity:** Environment (this machine only).
- **What:** The default `node` is 22.13.1 (`engines` requires ≥ 22.18), and its Corepack fails with "Cannot find
  matching keyid". Milestone E was built and tested with Node 24.15.0 and Homebrew's pnpm 10.28.0.
- **To close:** `nvm alias default 24` (or install ≥ 22.18), and `corepack enable` on that version.
- **Resolved:** `nvm alias default 24` (→ 24.15.0) and `corepack enable` on it; a new login shell gets Node 24.15.0
  and pnpm 10.28.0 through Corepack 0.34.6.

## KI-018 — The Gemini provider has only been run live on a free-tier key
- **Severity:** Medium (the default Gemini model has not been scored, and the live gate has not run on Gemini).
- **Where:** `packages/llm/src/providers/gemini.ts`, `packages/llm/src/providers/gemini-json-schema.ts`.
- **What:** First live run, 2026-09-27, with a free-tier key. It found that the API rejected the compiler's and
  planner's schemas (400 INVALID_ARGUMENT on array bounds; fixed in `c00e140`). With the fix, on
  `gemini-3.5-flash-lite`: the evals score 23/25 and 12/14 (`evals/BASELINE.md`), the `@live` Stagehand smoke
  passes, and the live E2E suite passes cancel, destructive, SSRF and confirmation expiry. The six other cases
  failed on free-tier stalls (about 1 call in 5 was held 60–185 s before a normal answer; a run past the analysis
  budget ended `ERRORED / TIMEOUT`, others ran out of their time) and, in the prompt-injection case, on
  Flash-Lite planning a search on a page without one (`INCONCLUSIVE`; zero delete clicks). Every verdict followed
  the plan's rules, the demo password reached no row or log, and every call was priced. Not yet run: the default
  `gemini-3.8-flash` (the free tier allows it 5 requests a minute and 20 a day) and the live gate.
- **Risk:** Free-tier stalls make live runs fail on time, and on the free tier Google may use the prompts to
  improve its products: use a billing-enabled key. Thinking tokens count against each call's output limit (the
  report diagnostics call is capped at 4,000); `GEMINI_THINKING_LEVEL=low` is the lever if answers are cut short.
- **To close:** with a billing-enabled key, `LLM_PROVIDER=gemini GEMINI_API_KEY=… LLM_MODEL= pnpm eval
  requirement-compiler` and `… pnpm eval planner` (record the scores in `evals/BASELINE.md`), `… pnpm test:live --
  stagehand-smoke`, then the live gate with `LLM_PROVIDER=gemini` (see KI-001). `LLM_MODEL=` clears a Claude model
  exported from `.env`. Compare the compile's answer time on `gemini-3.8-flash` (with thinking) with the Gemini
  request timeout, 25 s: a slower answer is cut off and retried, so raise `DEFAULT_TIMEOUT_MS` in `gemini.ts` if
  answers get close to it.

## KI-019 — Gemini 3.6–3.8 Flash prices double on 2027-01-01
- **Severity:** Low (cost estimates only).
- **Where:** `packages/llm/src/pricing.ts`.
- **What:** Google's list price for `gemini-3.8-flash` (the Gemini default), `gemini-3.7-flash` and
  `gemini-3.6-flash` is $0.75 / $3.75 per MTok through 2026-12-31 and $1.50 / $7.50 from 2027-01-01. The table holds
  today's price, so from 2027 `estimatedCostUsd` and `llm_cost_usd_total` report half the real cost.
- **To close:** on 2027-01-01, set those three entries to $1.50 / $7.50 (and re-check Google's price list).

## KI-020 — A Stagehand step that times out holds up the next step's model call
- **Severity:** Medium (seen on the live Gemini run; any provider stall triggers it).
- **Where:** `packages/stagehand-adapter/src/client-llm.ts` (calls run one at a time, on the run's signal).
- **What:** Stagehand gives each observe/act/extract 60 s. When a step times out, its model call keeps going,
  retries included, because the bridge only has the run's abort signal. The bridge runs calls one at a time (so
  usage is attributed to one operation), so the next step's call waits for the abandoned one, and a single stall
  can fail two steps: on the live Gemini run (KI-018), two consecutive `observe` steps failed about 70 s apart
  while one request was held for 120 s.
- **Fix:** end a call when its Stagehand operation gives up, e.g. abort it on the operation's own timeout, so the
  next call starts at once.
