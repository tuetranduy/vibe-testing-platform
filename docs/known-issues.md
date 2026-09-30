# Known issues

Outstanding defects, gaps and open decisions after Milestone E (recorded 2026-09-27). Each has an ID to refer
to when it is picked up; mark it resolved here (with the commit) rather than deleting it.

Severity: **High** blocks the V1 release gate or can hide a real failure; **Medium** is a correctness or
operability gap a user or operator will hit; **Low** is polish, test hygiene or a misleading edge case.

KI-002 to KI-017 were resolved on 2026-09-27 (branch `fix/known-issues`); each entry names its commit. KI-001 and KI-018
are open: both need a paid model key. KI-019 and KI-020 were resolved on 2026-09-28. KI-021 to KI-030 came from the
audit of 2026-09-29 against the plan; the plan's Revision 3 lists what is outstanding in priority order. KI-028 was
resolved by V1.1 (branch `feat/v1.1`, 2026-09-29), which also recorded KI-031 to KI-035.

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
| KI-019 | Low | Cost metrics | Gemini 3.6–3.8 Flash prices double on 2027-01-01 | Resolved `13ac37a` |
| KI-020 | Medium | Exploration | A Stagehand step that times out holds up the next step's model call | Resolved `5c64c0c` |
| KI-021 | High | Safety | Destructive-action policy misses most destructive buttons (English list only) | Resolved (2026-09-29) |
| KI-022 | Medium | Secrets | A secret typed into an edited suggestion or criterion is stored in plain text | Resolved (2026-09-29) |
| KI-023 | Medium | Deployment | Production starts with the example encryption key and API token | Resolved (2026-09-29) |
| KI-024 | Medium | Crash recovery | Lost runs are detected only while some worker is alive | Resolved (2026-09-29) |
| KI-025 | Medium | Process | No CI; the repository has no remote | CI added; remote open |
| KI-026 | Medium | LLM quality | Most models offered in Settings have never been evaluated | Open (needs paid keys) |
| KI-027 | Low | Data model | D6: only 4 tables carry `tenant_id`; child rows rely on `run_id` | Open |
| KI-028 | Low | Audit | Revealing a secret-bearing artifact is only a log line | Resolved `6026592` (V1.1) |
| KI-029 | Low | Isolation | The rerun runner is a worker child process; its image was never built | Open |
| KI-030 | Low | Docs | Stale plan copy in `Claude outputs/`; architecture doc never added | Open |
| KI-031 | Medium | LLM quality | The planner's multi-scenario prompt (V1.1) has never run against a real model | Open (needs paid keys) |
| KI-032 | Low | Exploration | The exploration cache trusts a lookup whose locator still matches | Open |
| KI-033 | Low | Secrets | Saved credential profiles are decrypted by the API at run creation | Open (by design) |
| KI-034 | Low | Users | Sessions: no list, no "sign out everywhere" short of a password change | Open |
| KI-035 | Low | Users | Users exist only in the default tenant | Open |

---

## KI-001 — Live E2E gate has not been run
- **Severity:** High (Milestone E acceptance: "live suite green 3 times in a row").
- **Where:** `scripts/e2e-live-gate.sh`, `tests/e2e/platform-*.spec.ts`, `tests/e2e/platform-injection.spec.ts`.
- **What:** The gate (live mode, `E2E_MODE=live`: real model + Stagehand, green 3 times in a row) has never
  run; the prompt-injection spec (Task 21 step 6) runs only in live mode. The live suite ran twice on a free-tier
  Gemini key on 2026-09-27/28 (6 and 7 of 12 cases green; see KI-018), but the gate needs a paid key: the
  `ANTHROPIC_API_KEY` in the implementation environment has no credit ("Your credit balance is too low",
  re-checked 2026-09-28), and the free Gemini tier allows 15 requests a minute on `gemini-3.5-flash-lite` and 5 a
  minute (20 a day) on `gemini-3.8-flash`, which one run of the suite exceeds.
- **Risk:** Some specs identify criteria by check kind (`numeric_compare`, `collection_contains`); a real model
  may phrase criteria differently. Loosen only assertions that pin model wording, never platform guarantees
  (`verdictSource`, blocking reasons, secret hygiene). The two cases added for KI-006 and KI-009 are CI-only
  (they depend on the scripted plan), so the live suite runs the same cases as before.
- **2026-09-29:** a new `GEMINI_API_KEY` in `.env` turned out to be free tier too. `pnpm eval requirement-compiler`
  on `gemini-3.8-flash` got `503 UNAVAILABLE` ("high demand") on its first calls, then `429 RESOURCE_EXHAUSTED`
  (`generate_content_free_tier_requests, limit: 20`) — 0 of 25 cases reached an answer, so the evals and the gate
  were stopped. Enabling billing on the key's Google Cloud project lifts the free-tier limits for the same key.
- **To close:** with Anthropic credit, `pnpm infra:up && ANTHROPIC_API_KEY=… ./scripts/e2e-live-gate.sh`; or with a
  billing-enabled Gemini project, `pnpm infra:up && LLM_PROVIDER=gemini GEMINI_API_KEY=… LLM_MODEL=
  ./scripts/e2e-live-gate.sh`. Then record the date and result in README "Status", and tick Task 21 step 6 in the
  plan.

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
- **Resolved** (`13ac37a`): a price in `pricing.ts` can carry changes the provider announced, each from a UTC date,
  and the three models switch to $1.50 / $7.50 on 2027-01-01 without an edit; `LlmClient` prices a call when its
  answer arrives. Two tests that priced `gemini-3.8-flash` at "now" (and would have failed in 2027) are dated.

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
- **Resolved** (`5c64c0c`): the explorer runs each Stagehand call through `bridge.operation()`. When the operation
  ends, a model call it left running is aborted (recorded `CANCELLED`), a call made after it ended is refused
  without reaching the model (Stagehand's timeout only stops waiting, and `extract` makes its two calls back to
  back), and neither one's error is reported for the next operation. Tested on the bridge alone and with real
  Chromium and Stagehand (`tests/integration/stagehand-adapter.test.ts`).

## KI-021 — Destructive-action policy misses most destructive buttons
- **Severity:** High (D9: destructive actions blocked by default; the executor's element check is the only
  deterministic guard when a page steers a harmless step onto such a button).
- **Where:** `packages/security/src/action-policy.ts`.
- **What:** The term list was the plan's English list. Of 37 realistic button labels, only "Delete account", "Place
  order" and "Pay now" were denied: "Confirm payment", "Submit order", "Terminate account", "Erase all data",
  "Revoke access" and every non-English label ("Konto löschen", "Supprimer le compte", "Eliminar cuenta") passed.
  `\b` also never matched around non-ASCII letters.
- **Resolved:** erasing / revoking / closing terms, commit verb + order/payment/booking noun (not before
  "confirmation", "summary", "form", "page"…), bookings and donations, and German, French, Spanish, Italian,
  Portuguese and Dutch terms; text is compared without diacritics, with Unicode word boundaries. Tests cover each
  label above and the look-only phrases that must stay allowed. The list stays a backstop, not a dictionary.

## KI-022 — A secret typed into an edited suggestion or criterion is stored in plain text
- **Severity:** Medium (Section 6: secret values never appear in DB rows).
- **Where:** `apps/api/src/services/suggestion-service.ts`, `criteria-service.ts`.
- **What:** The API cannot decrypt secrets (D7), so an edited suggestion was stored with key-based redaction only
  (the worker masked values when it picked the run up — never, if the run ended first), and criteria edits were not
  redacted at all.
- **Resolved:** at creation the API stores an HMAC fingerprint of each value (`run_secrets.fingerprint`, migration
  `0003_secret_fingerprints`; wiped by purge) and later scans edited text window by window: a selected suggestion's
  text has the value masked before it is stored; a criteria edit containing one is refused (`400`), since masking
  would change the check. Plain form only (the worker still masks encoded forms before model calls); runs created
  before the change have no fingerprints.

## KI-023 — Production starts with the example encryption key and API token
- **Severity:** Medium.
- **Where:** `packages/config/src/env.ts`.
- **Resolved:** with `NODE_ENV=production`, a `SECRETS_ENCRYPTION_KEY` with fewer than 16 distinct byte values (the
  all-zero example) and the development `API_TOKEN` fail start-up, like the private allowlist and the fake provider.

## KI-024 — Lost runs are detected only while some worker is alive
- **Severity:** Medium (Section 6: worker crashes detected within 2 minutes).
- **What:** The reaper ran only inside workers, so with the only worker down no run was ended `WORKER_LOST`; with a
  60 s stale threshold and a 60 s interval, detection took up to 120 s even with one up.
- **Resolved:** the reaper moved to `@platform/event-bus` (`startReaper`) and is consumed by the workers and the
  API (one of them per tick), every 30 s: at most about 90 s. A test runs it with no worker at all.

## KI-025 — No CI; the repository has no remote
- **Severity:** Medium.
- **What:** Nothing ran the suites on a change, the plan's nightly live suite had no scheduler, and every commit
  existed on one machine only.
- **Partly resolved:** `.github/workflows/ci.yml` (see `docs/operations.md`, "Release checks"); it has not run yet.
- **To close:** add a remote (e.g. a private GitHub repository), push, add the `GEMINI_API_KEY` secret, and check the
  first run.

## KI-026 — Most models offered in Settings have never been evaluated
- **Severity:** Medium.
- **What:** Only `claude-sonnet-5` and `gemini-3.5-flash-lite` had eval scores; the survey eval had never run.
- **Status:** not yet scored. The 2026-09-29 attempt on `gemini-3.8-flash` stopped on the free-tier quota (KI-001).
  Needs a billing-enabled Gemini key (the Gemini models) and an `ANTHROPIC_API_KEY` with credit (the Claude models):
  `pnpm eval requirement-compiler`, `planner` and `survey` per model, rows in `evals/BASELINE.md`.

## KI-027 — D6: only 4 tables carry `tenant_id`
- **Severity:** Low (single tenant today).
- **Where:** `packages/db/src/schema.ts`.
- **What:** D6 says every row carries `tenantId` so multi-tenancy needs no migration. `test_runs`, `artifacts`,
  `llm_settings` and `llm_provider_keys` do; the 11 run child tables (events, results, secrets, requirement
  revisions, …) reach the tenant through `run_id`. Every API read is tenant-scoped through the run, so nothing
  leaks today.
- **To close:** add `tenant_id` to the child tables (backfilled from `test_runs`) before a second tenant exists, or
  amend D6 to "every run carries it; child rows inherit it".

## KI-028 — Revealing a secret-bearing artifact is only a log line
- **Severity:** Low.
- **Where:** `apps/api/src/routes/artifacts.ts` (`deps.audit` exists but `main.ts` does not wire it).
- **What:** Task 7 asks for reveals to be audit-logged; they are a pino `warn` line, not a durable record, and V1 has
  no user identity to record.
- **To close:** persist reveals (an `artifact.revealed` run event, or an audit table) when user authentication
  arrives (V1.1 multi-user login).
- **Resolved (V1.1, `6026592`):** every reveal writes an `audit_events` row (`artifact.reveal`, the run, the
  artifact and its type) with the user who revealed it.

## KI-029 — The rerun runner is a worker child process; its image was never built
- **Severity:** Low (the generated source is compiler-emitted and passes the AST guard).
- **Where:** `apps/worker/src/sandbox/runner-process.ts`, `infra/runner/Dockerfile`.
- **What:** Task 17 plans a sandboxed runner image. The rerun runs as a child process with an environment allow-list
  but the worker's user, filesystem and network; `infra/runner/Dockerfile` has never been built. With no navigation
  guard in the rerun (Ruling R31), any public host is reachable from it through its egress proxy.
- **To close:** run the rerun in the runner image (separate container, no route to the database, Redis or S3), and
  add a navigation guard to the generated test's context.

## KI-030 — Stale plan copy; architecture doc never added
- **Severity:** Low.
- **What:** `Claude outputs/ai-testing-platform-implementation-plan.md` is an old copy of the plan (every box
  unticked, no Revision 3); `docs/ai-testing-platform-architecture.md`, which the plan names as its spec, never
  existed (the plan with Revision 3 serves as the spec).
- **To close:** delete the copy; either write the architecture doc from Section 2 or drop the reference.

## KI-031 — The planner's multi-scenario prompt has never run against a real model
- **Severity:** Medium.
- **Where:** `packages/testing-engine/src/planner/prompts.ts`, `model-output.ts` (V1.1 F9).
- **What:** the planner now answers `{ scenarios: [{ title, steps }], stopConditions }` and is told to split criteria
  into scenarios only when they need different starting states. Unit tests, the scripted E2E run and a real
  two-scenario rerun pass, but no real model has produced a plan with this prompt: it may split too eagerly (costing
  time) or never.
- **To close:** `pnpm eval planner` on every offered model (with KI-026), plus a golden case that needs two scenarios.

## KI-032 — The exploration cache trusts a lookup whose locator still matches
- **Severity:** Low.
- **Where:** `packages/testing-engine/src/exploration/executor.ts` (`fromCache`), `exploration_cache`.
- **What:** a cached lookup is reused when its selector resolves to an element whose chosen locator (role + name,
  test id, …) equals the one recorded. A page that keeps the locator but changes what the element does is not
  noticed; a lookup a prompt-injected page steered the model to can be cached once its step succeeded. The action
  policy still checks every element, and entries hold page-derived text (accessible names) for up to 30 days per
  tenant.
- **To close:** optionally re-run `observe` on a sample of hits and compare; or bind entries to a page fingerprint.
  Administrators can clear the cache (Settings) after a redesign or an incident.

## KI-033 — Saved credential profiles are decrypted by the API at run creation
- **Severity:** Low (by design, V1.1 F4; D7 amended).
- **Where:** `apps/api/src/services/credential-profile-service.ts` (`secretsFor`).
- **What:** D7 kept secret plaintext out of the API after a run is created. A saved profile's values are decrypted in
  the API when a run (or a rerun) uses it, to store them as the run's own secrets, and they stay at rest (encrypted)
  for as long as the profile exists. A compromised API process can therefore read profile values.
- **To close (if the risk matters):** let the worker decrypt profile values itself, with run-scoped copies made
  there.

## KI-034 — Sessions: no list, no "sign out everywhere" short of a password change
- **Severity:** Low.
- **Where:** `apps/api/src/services/user-service.ts`, `user_sessions`.
- **What:** a user cannot see or end their other sessions except by changing their password; an administrator ends a
  user's sessions by resetting the password or disabling the account. Sessions have a fixed lifetime
  (`SESSION_TTL_HOURS`), not an idle timeout.
- **To close:** a sessions list on `/account` with "sign out other sessions".

## KI-035 — Users exist only in the default tenant
- **Severity:** Low (single tenant, D6).
- **Where:** `apps/api/src/routes/auth.ts` (login looks users up in `DEFAULT_TENANT_ID`).
- **What:** accounts are tenant-scoped in the schema, but sign-in, the bootstrap administrator and user management
  all act on the default tenant. A second tenant would need a way to choose the tenant at sign-in.
- **To close:** with multi-tenancy (V2), together with KI-027.

