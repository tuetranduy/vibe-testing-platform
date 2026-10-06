# Known issues

Outstanding defects, gaps and open decisions after Milestone E (recorded 2026-09-27). Each has an ID to refer
to when it is picked up; mark it resolved here (with the commit) rather than deleting it.

Severity: **High** blocks the V1 release gate or can hide a real failure; **Medium** is a correctness or
operability gap a user or operator will hit; **Low** is polish, test hygiene or a misleading edge case.

KI-002 to KI-017 were resolved on 2026-09-27 (branch `fix/known-issues`); each entry names its commit. KI-001 and KI-018
are open: both need a paid model key. KI-019 and KI-020 were resolved on 2026-09-28. KI-021 to KI-030 came from the
audit of 2026-09-29 against the plan; the plan's Revision 3 lists what is outstanding in priority order. KI-028 was
resolved by V1.1 (branch `feat/v1.1`, 2026-09-29), which also recorded KI-031 to KI-035. V1.2 (branch `feat/v1.2`,
2026-09-30) recorded KI-036 to KI-040. On 2026-09-30 (branch `fix/open-issues`) every open issue was worked with a
DeepSeek key, DeepSeek standing in for Gemini where a paid key was needed: all but KI-001 (the live gate, not yet
green on DeepSeek) and KI-025 / KI-036 (they need the branch pushed to GitHub) are resolved or closed by decision.

| ID | Severity | Area | Summary | Status |
|---|---|---|---|---|
| KI-001 | High | Release gate | Live E2E gate (3 consecutive green runs) has not been run | Open: not green on DeepSeek (model variance; pass case 1 of 3 on V4 Pro, 2026-10-05); needs a paid Claude key |
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
| KI-018 | Medium | LLM provider | The Gemini provider has only been run live on a free-tier key | Closed: superseded by DeepSeek (2026-09-30) |
| KI-019 | Low | Cost metrics | Gemini 3.6–3.8 Flash prices double on 2027-01-01 | Resolved `13ac37a` |
| KI-020 | Medium | Exploration | A Stagehand step that times out holds up the next step's model call | Resolved `5c64c0c` |
| KI-021 | High | Safety | Destructive-action policy misses most destructive buttons (English list only) | Resolved (2026-09-29) |
| KI-022 | Medium | Secrets | A secret typed into an edited suggestion or criterion is stored in plain text | Resolved (2026-09-29) |
| KI-023 | Medium | Deployment | Production starts with the example encryption key and API token | Resolved (2026-09-29) |
| KI-024 | Medium | Crash recovery | Lost runs are detected only while some worker is alive | Resolved (2026-09-29) |
| KI-025 | Medium | Process | No CI; the repository has no remote | CI added; remote open |
| KI-026 | Medium | LLM quality | Most models offered in Settings have never been evaluated | Open (needs paid keys) |
| KI-027 | Low | Data model | D6: only 4 tables carry `tenant_id`; child rows rely on `run_id` | Resolved `3a61f16` |
| KI-028 | Low | Audit | Revealing a secret-bearing artifact is only a log line | Resolved `6026592` (V1.1) |
| KI-029 | Low | Isolation | The rerun runner is a worker child process; its image was never built | Resolved `1e2081d`, `ca9ef74` |
| KI-030 | Low | Docs | Stale plan copy in `Claude outputs/`; architecture doc never added | Resolved `08d29b0` |
| KI-031 | Medium | LLM quality | The planner's multi-scenario prompt (V1.1) has never run against a real model | Resolved for DeepSeek Flash (2026-10-06); other models with KI-026 |
| KI-032 | Low | Exploration | The exploration cache trusts a lookup whose locator still matches | Resolved `66f5afd` |
| KI-033 | Low | Secrets | Saved credential profiles are decrypted by the API at run creation | Closed: decision (2026-09-30) |
| KI-034 | Low | Users | Sessions: no list, no "sign out everywhere" short of a password change | Resolved `9a5bfa0` |
| KI-035 | Low | Users | Users exist only in the default tenant | Resolved `8e0d47a` |
| KI-036 | Medium | CI | The GitHub Action has never run on GitHub | Open (needs KI-025's remote) |
| KI-037 | Low | Schedules | Schedules fire only while an API process is up; a missed firing runs late, once | Resolved `ad47ad2` |
| KI-038 | Low | Admission | A suite run takes one slot but queues all of its tests at once | Resolved `f41b0d6` |
| KI-039 | Low | Performance | Suite-run views compare every child with its previous run on each read | Resolved `c0c9e09` |
| KI-040 | Low | Tokens | The web app's per-minute token limit is per instance and in memory | Resolved `4287733` |
| KI-041 | Medium | LLM quality | The requirement compiler's prompt changed without an eval run | Resolved (2026-09-30, `af80be5`) |
| KI-042 | Low | Recordings | Exploration video and trace have not been recorded in a live run | Resolved (2026-09-30, live DeepSeek run) |
| KI-043 | Medium | LLM | The DeepSeek provider has not been run against the live API | Resolved (2026-09-30): run live; see KI-001 |

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
- **2026-09-30, DeepSeek (the provider chosen in place of Gemini, KI-018):** the gate ran on `deepseek-flash`:
  run 1 of 3 failed: 14 of 27 live cases passed, 13 failed (the prompt-injection case among them). Most failures are the happy-path run ending `INCONCLUSIVE`
  instead of `PASSED`, which the suite, rerun, comparison, schedule, token and CI cases build on. Diagnosed on
  `platform-pass` with `E2E_KEEP_LOGS=1`:
  1. The planner wrote a `wait_for` step naming no element ("Wait until the search results page has loaded"), so
     exploration stopped. Fixed (`58f19ba`: the prompt now requires `wait_for` to name an element); the flow then
     runs end to end.
  2. Flash proposed a criterion the requirement does not state (the cart's contents "right after" adding, i.e. a
     mini-cart the demo shop does not have: `FACT_NOT_OBSERVED`) — the over-splitting its compiler eval shows.
  3. Flash extracts list facts as asked ("names of the products": `iPhone 17 Pro`) while the page's items carry
     more text (`iPhone 17 Pro — $1,199.00`). The DOM check needs each item to be equal, so those facts stay
     `MODEL_EXTRACTED` and their criteria `UNVERIFIED_EVIDENCE`. Accepting "contained in" would make the verifier
     judge the DOM's longer text and turn an `equals` criterion from inconclusive into a false FAIL: a verdict-rule
     decision, left open deliberately. **Decided 2026-10-04:** neither "contained in" nor a looser rule. When the
     whole rows differ, the reader looks for one sub-element of the rows (test id, tag and classes, itemprop, tag)
     whose texts, read from every row, *equal* the model's list; the fact is then DOM_VERIFIED with that
     `read.itemSelector`, and the compiled rerun replays it (`readItemTexts`). Exact matching still decides
     provenance; rows with no such element keep the fact MODEL_EXTRACTED as before.
  `deepseek-v4-pro` (better compiler score) is too slow here with thinking on: the pass run was still exploring at
  the suite's 180 s limit. Every failing case failed on the run's verdict, or (the confirmation case) on editing a criterion the scripted
  model proposes and DeepSeek did not. **To close:** ~~decide (3)~~ (done); then either a lower reasoning level for V4 Pro (Settings, per model) within
  the suite's time limits, or a paid Claude key, and re-run `./scripts/e2e-live-gate.sh`.
- **2026-10-04/05, `deepseek-v4-pro` at lower reasoning levels** (the pass case alone, `E2E_KEEP_LOGS=1`; the full gate
  was not run). `LLM_REASONING` (`01630af`) sets the level for the live suite.
  1. **Speed.** At `low` the compiler eval keeps its score (25/27, 17 s a case against 26 s at high), but the pass case
     still overran 180 s in 3 of 4 runs: Stagehand's browser steps ran at the model's default (thinking high), 10–27 s
     an observe. They now follow the run's level (`19d7dbf`); even so `low` still thinks (up to 2,800 output tokens a
     call). With thinking off (`LLM_REASONING=minimal`) a pass run takes 26–63 s, and the evals score 26/27 and 15/15
     (`evals/BASELINE.md`).
  2. **Waits for a page "to load".** V4 Pro without thinking ignores the planner's rule that `wait_for` names an element
     (`58f19ba`), and the unfound element stopped exploration. A failed `wait_for` no longer stops it (`042414e`).
  3. **"see the selected product in the cart"** was compiled `semantic` + ambiguous in every V4 Pro run, so the cart was
     never read; then, with a rule for it, as a cart list read at `after_add` (still the product page: the model read
     the `Cart (1)` badge as the list, refused as UNVERIFIED_EVIDENCE). Two compiler rules and eval cases 28–29
     (`9ae38b1`): in 3 live runs since, every cart check was on `cart_page` against the name read on the product page.
  4. **Result: 1 of 3 pass runs green** (the first green pass case on DeepSeek, rerun-confirmed). The two others: the
     browser agent did not locate the cart list's container (its model-read value stayed MODEL_EXTRACTED), and the
     compiler split the requirement into 7 criteria, one a `semantic` duplicate of a correct `collection_contains` one.
     Both are model variance, not a platform defect found; the compiler eval moves 24–28 of 29 between identical runs.
  **Stopped here on DeepSeek (2026-10-05).** The gate needs the 27-case suite green 3 times in a row, which V4 Pro
  without thinking is far from. **To close:** a paid Claude key (`ANTHROPIC_API_KEY=… ./scripts/e2e-live-gate.sh`); or,
  to keep on DeepSeek, the next leads are the browser agent missing list containers and duplicate `semantic` criteria.

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
- **Closed (2026-09-30, superseded):** the project's live-tested provider is DeepSeek (KI-043): the evals, the
  `@live` Stagehand smoke, CI's nightly live suite and the release gate run on it. Gemini stays offered and works
  (free-tier runs above), but a billing-enabled Gemini key was never available, so its default model is unscored;
  score it (the commands above) if a Gemini key becomes the one in use.

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
- **Resolved (`3a61f16`):** the 12 run child tables (`run_secrets`, `requirement_revisions`, `test_plans`,
  `run_suggestions`, `run_site_analyses`, `exploration_steps`, `observed_facts`, `criterion_results`,
  `generated_tests`, `test_events`, `diagnostic_findings`, `llm_calls`) carry `tenant_id`, backfilled from `test_runs`
  (migration 0016) and filled by the `set_run_tenant_id` trigger on every insert, so no writer passes it and a
  writer cannot set another tenant's. `tenant-ids.test.ts` checks every table with a `run_id` has it.

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
- **Resolved:** the navigation guard (`1e2081d`): the rerun workspace's fixed `global-setup.js` launches the
  rerun's Chromium (sandbox on, through the egress proxy) and guards every main-frame navigation over CDP, redirect
  hops and popups included, as exploration does; the stored test connects to it through Playwright's
  `PW_TEST_CONNECT_WS_ENDPOINT`, so saved tests rerun unchanged. A blocked navigation fails that step, and the
  criterion's error says the rerun was stopped from leaving the allowed website. The runner container (`ca9ef74`):
  compose runs the reruns in the `runner` service (the worker image's `runner` target), on an internal network with
  the workers only and the `runs` workspace volume; its browser reaches the worker's per-rerun egress proxy (which
  then accepts only the runner's address) over a loopback forwarder. `RUNNER_URL` / `RUNNER_TOKEN` turn it on;
  without them the worker keeps its child process (local development).

## KI-030 — Stale plan copy; architecture doc never added
- **Severity:** Low.
- **What:** `Claude outputs/ai-testing-platform-implementation-plan.md` is an old copy of the plan (every box
  unticked, no Revision 3); `docs/ai-testing-platform-architecture.md`, which the plan names as its spec, never
  existed (the plan with Revision 3 serves as the spec).
- **To close:** delete the copy; either write the architecture doc from Section 2 or drop the reference.
- **Resolved (`08d29b0`):** the stale copy is deleted; the plan (with Revision 3) is named as the spec in the
  plan and the README, and no architecture doc is referenced.

## KI-031 — The planner's multi-scenario prompt has never run against a real model
- **Severity:** Medium.
- **Where:** `packages/testing-engine/src/planner/prompts.ts`, `model-output.ts` (V1.1 F9).
- **What:** the planner now answers `{ scenarios: [{ title, steps }], stopConditions }` and is told to split criteria
  into scenarios only when they need different starting states. Unit tests, the scripted E2E run and a real
  two-scenario rerun pass, but no real model has produced a plan with this prompt: it may split too eagerly (costing
  time) or never.
- **To close:** `pnpm eval planner` on every offered model (with KI-026), plus a golden case that needs two scenarios.
- **Resolved for `deepseek-flash` (2026-10-06):** the golden case exists (planner case 15, signed-out and signed-in), and
  the planner eval now scores every other case on exactly one scenario, so a split where none is needed counts as
  splitting too eagerly. On Flash, over 10 runs: case 15 planned as 2 scenarios in 8 (twice as 1), and 1 of the 150
  one-scenario plans was split (search-results, as 2) (`evals/BASELINE.md`); `deepseek-v4-pro` also passed case 15 with thinking off. The live suite does not
  cover it: its two-scenario spec (`platform-v11`) runs in CI mode only (scripted plan). The other offered models are
  still unscored: they need paid keys (KI-026).

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
- **Resolved (`66f5afd`, `bdad5f3`):** an entry records what its element does (tag, type, link target, form action
  and method, as origin + path) and a hit is used only while the element still does the same; entries from before
  it are misses and are rewritten. One hit in ten (`cacheRecheckRate`) asks the explorer again anyway, and the fresh
  lookup replaces the entry, so a stale or steered entry does not live out its 30 days.

## KI-033 — Saved credential profiles are decrypted by the API at run creation
- **Severity:** Low (by design, V1.1 F4; D7 amended).
- **Where:** `apps/api/src/services/credential-profile-service.ts` (`secretsFor`).
- **What:** D7 kept secret plaintext out of the API after a run is created. A saved profile's values are decrypted in
  the API when a run (or a rerun) uses it, to store them as the run's own secrets, and they stay at rest (encrypted)
  for as long as the profile exists. A compromised API process can therefore read profile values.
- **To close (if the risk matters):** let the worker decrypt profile values itself, with run-scoped copies made
  there.
- **Closed (2026-09-30, decision):** moving the decryption to the worker would not reduce the risk: the API holds
  `SECRETS_ENCRYPTION_KEY` (it encrypts every secret typed into a run and every profile value) and reads the
  database, so a compromised API process can decrypt profile values whichever process normally does. Removing the
  risk needs asymmetric encryption (the API encrypts to a key only the worker can open), which would change every
  stored secret: a V2 decision, recorded here rather than a change that only looks safer.

## KI-034 — Sessions: no list, no "sign out everywhere" short of a password change
- **Severity:** Low.
- **Where:** `apps/api/src/services/user-service.ts`, `user_sessions`.
- **What:** a user cannot see or end their other sessions except by changing their password; an administrator ends a
  user's sessions by resetting the password or disabling the account. Sessions have a fixed lifetime
  (`SESSION_TTL_HOURS`), not an idle timeout.
- **To close:** a sessions list on `/account` with "sign out other sessions".
- **Resolved (`9a5bfa0`):** `/account` lists the person's live sessions (browser, signed in, last active, ends)
  with "Sign out" for each other session and "Sign out other sessions"
  (`GET /v1/auth/sessions`, `DELETE /v1/auth/sessions/:id`, `POST /v1/auth/sessions/revoke-others`, audited).
  Sessions record the browser's User-Agent at sign-in (migration 0015).

## KI-035 — Users exist only in the default tenant
- **Severity:** Low (single tenant, D6).
- **Where:** `apps/api/src/routes/auth.ts` (login looks users up in `DEFAULT_TENANT_ID`).
- **What:** accounts are tenant-scoped in the schema, but sign-in, the bootstrap administrator and user management
  all act on the default tenant. A second tenant would need a way to choose the tenant at sign-in.
- **To close:** with multi-tenancy (V2), together with KI-027.
- **Resolved (`8e0d47a`):** a sign-in may name its tenant (`tenant` in the login request; `/login?org=<id>` in the web
  app); an unknown one fails like a wrong password. `pnpm --filter @platform/api create-tenant` adds a tenant with its
  first administrator, who adds the others. With KI-027, a second tenant needs no migration.

## KI-036 — The GitHub Action has never run on GitHub
- **Severity:** Medium (V1.2 F5).
- **Where:** `.github/actions/run-suite/`, `integrations/platform-client/`.
- **What:** the action and the CLI are tested with a fake platform (unit tests) and the client's core against the E2E
  stack (the web app's `/api/ext` path emulated by the test), but the action has never run inside GitHub Actions: the
  repository has no remote (KI-025). Input names, `$GITHUB_OUTPUT` / `$GITHUB_STEP_SUMMARY` handling and the
  `node24` runtime follow GitHub's documentation, unverified.
- **To close:** with KI-025's remote, run the example workflow in `integrations/README.md` against a deployed web app.

## KI-037 — Schedules fire only while an API process is up
- **Severity:** Low (by design, V1.2 F3).
- **Where:** `apps/api/src/services/schedule-worker.ts`.
- **What:** BullMQ's job schedulers produce the firings, but the API consumes them (a firing creates its suite run
  like the endpoint does). With no API process running, nothing fires; BullMQ keeps the next firing as a delayed job, so
  when an API comes back that one firing runs late and the missed ones in between are not made up.
- **To close (if needed):** record `nextRunAt` and skip firings older than a grace period, or let the worker fire.
- **Resolved (`ad47ad2`):** a firing taken more than 15 minutes after it was due (`SCHEDULE_GRACE_MINUTES`; the due
  time is the scheduler job's timestamp + delay) is skipped (`skipped_late`, audited as `schedule.skipped`) instead
  of starting a suite run hours late; the next firing runs on time.

## KI-038 — A suite run takes one slot but queues all of its tests at once
- **Severity:** Low (V1.2 F1, admission amended).
- **Where:** `apps/api/src/services/suite-run-service.ts`, `packages/db/src/run-repository.ts` (`countActive`).
- **What:** the active-run cap counts a running suite run once, whatever its size, and its children not at all; all of
  its tests are enqueued together. Worker concurrency still bounds how many run at once, but a 50-test suite puts 50 jobs
  ahead of anything queued after it. Each child's `QUEUED` wait also counts towards the reaper's "never picked up"
  check only while its job is gone, so long queues are safe.
- **To close:** enqueue a suite run's children a few at a time (e.g. as each one finishes).
- **Resolved (`f41b0d6`):** a suite run's children are queued with a BullMQ priority (child n: n + 1). Jobs without
  one — single runs, reruns, analyses — go first, and several suites' children take turns, so a 50-test suite no
  longer holds up what is queued after it.

## KI-039 — Suite-run views compare every child with its previous run on each read
- **Severity:** Low (V1.2 F2).
- **Where:** `apps/api/src/services/comparison-service.ts` (`changesOf`).
- **What:** `GET /v1/suite-runs/:id` compares each completed child with its previous run from the stored results
  (about four queries per child), and the suite-run page polls every 3 s while it runs: a 50-test suite costs ~200 small
  queries per poll.
- **To close:** store each child's change when it completes (the worker knows), or cache per settled child.
- **Resolved (`c0c9e09`):** a completed child's change is cached per caller scope and child (10 minutes, at most
  10,000 entries per API instance) and computed in parallel; a poll of a settled suite run makes no comparison
  queries.

## KI-040 — The web app's per-minute token limit is per instance and in memory
- **Severity:** Low (V1.2 F4).
- **Where:** `apps/web/lib/ext-proxy.ts`.
- **What:** `/api/ext` allows 120 requests per token prefix and minute per web instance, counted in memory (reset on
  restart, multiplied by the number of instances). The API's limit (600 per token and hour, in Redis) is the real one.
- **To close:** count in Redis from the web app too, or rely on the API's limit only.
- **Resolved (`4287733`):** the web app no longer counts; the API counts each token's requests per minute (120) and
  per hour (600) in Redis, shared by every instance, and the web app passes its `429` / `Retry-After` through.

## KI-041 — The requirement compiler's prompt changed without an eval run
- **Severity:** Medium (V1.3).
- **Where:** `packages/testing-engine/src/requirement/prompts.ts`, `packages/testing-engine/src/planner/prompts.ts`,
  `evals/requirement-compiler`, `evals/planner`.
- **What:** the compile prompt gained the live-site section (pages, `siteChecks`, `testData`), and both the compile
  and planner prompts a rule for credentials taken from the requirement (`[secret: <name>]`, V1.3.1). The prompt tells the
  model not to drop, add or weaken criteria because of the pages, but the eval baseline (`evals/BASELINE.md`) was
  recorded before it, and the evals were not re-run (no model key in the implementation environment). The eval
  suite still runs without pages, so it does not measure the live-site path either.
- **To close:** re-run `pnpm eval requirement-compiler` with a key; add cases with recorded page inventories.
- **Resolved (2026-09-30, `af80be5`):** the suite was re-run at the current prompts (`7e53baa`) on both DeepSeek
  models (`evals/BASELINE.md`), and cases can now carry the live site's pages (`pages`, as the analysis reads them):
  cases 26–27 give the demo shop's recorded pages (from `evals/survey/cases/01-demo-shop-home.yaml`) to requirements
  that also run without them, with the same expectations. Both pass on `deepseek-flash`: the pages added, dropped or
  weakened no criterion and invented no credential.

## KI-042 — Exploration video and trace have not been recorded in a live run
- **Severity:** Low (V1.3).
- **Where:** `apps/worker/src/sandbox/session-recording.ts`.
- **What:** the recorder is tested against a real Chromium over CDP, and in the integration explore test with the
  real sandbox and Stagehand driving the same page against the demo shop (video + scrubbed trace stored), but not yet
  in a live-model run or in the compose worker. The screencast follows the page's target: a navigation that swaps
  renderer processes (e.g. to another site allowed by `additionalAllowedHosts`) could end the stream early (the video
  then stops there; the trace is unaffected).
- **To close:** a live E2E run with recordings on; if videos stop early, restart the screencast on `framenavigated`.
- **Resolved (2026-09-30):** live DeepSeek runs of the E2E suite recorded and stored the exploration video and the
  scrubbed trace (`Exploration video stored`, `Exploration trace stored` events of the run) through the real worker.
  No early-ending video was seen on the demo shop (one host, no renderer
  swap); the `framenavigated` restart stays the remedy if one is.

## KI-043 — The DeepSeek provider has not been run against the live API
- **Severity:** Medium (no eval score or live E2E run on DeepSeek yet).
- **Where:** `packages/llm/src/providers/deepseek.ts`, `packages/llm/src/pricing.ts`.
- **What:** added 2026-09-30 from DeepSeek's API reference (checked that day) and tested against recorded response
  shapes, without a key. DeepSeek's JSON Output takes no schema, so the schema is written into the system prompt and
  only LlmClient's validation (and its one correction round) enforces it: expect more `INVALID_OUTPUT` records than on
  Claude or Gemini, above all on the compiler's and planner's larger schemas. Costs are estimates: input is priced at
  the cache-miss rate (cache hits cost about 2 % of it), and Chinese public holidays, billed off-peak, are priced at
  peak. `deepseek-v4-pro` takes no images, so a screenshot Stagehand sends it is replaced by a note.
- **To close:** `LLM_PROVIDER=deepseek pnpm eval …` on each suite (record the scores in `evals/BASELINE.md`), the
  `@live` Stagehand smoke and the live E2E suite; check the 120 s request timeout against thinking-mode answer times.
- **Resolved (2026-09-30):** run against the live API: all three eval suites on both models (`evals/BASELINE.md`),
  the `@live` Stagehand smoke (passes on `deepseek-flash`, 16 s) and the live E2E suite (KI-001: not green, for the
  model-quality reasons recorded there). No call reached the 120 s request timeout: V4 Pro's thinking-mode compiles
  took 26 s on average. `INVALID_OUTPUT` was not a failure cause in any eval case.
