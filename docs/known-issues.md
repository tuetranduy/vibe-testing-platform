# Known issues

Outstanding defects, gaps and open decisions after Milestone E (recorded 2026-09-27). Each has an ID to refer
to when it is picked up; mark it resolved here (with the commit) rather than deleting it.

Severity: **High** blocks the V1 release gate or can hide a real failure; **Medium** is a correctness or
operability gap a user or operator will hit; **Low** is polish, test hygiene or a misleading edge case.

| ID | Severity | Area | Summary |
|---|---|---|---|
| KI-001 | High | Release gate | Live E2E gate (3 consecutive green runs) has not been run |
| KI-002 | High | Deployment | Chromium's sandbox cannot start in the compose worker |
| KI-003 | Medium | Metrics | `test_run_duration_seconds` attributes the first stage of each job wrongly |
| KI-004 | Medium | Metrics | `runs_reaped_total` undercounts when a reaper pass fails midway |
| KI-005 | Medium | Compose | Worker metrics port published on all interfaces; fixed host port blocks scaling |
| KI-006 | Medium | E2E coverage | CI destructive spec never exercises the executor's DOM-level guard |
| KI-007 | Low | Logging | Run log scope is released outside a `finally` in `dispose()` |
| KI-008 | Low | Logging | Logger prints shared (non-cyclic) references as `"[Circular]"`; errors lose `stack` / `cause` |
| KI-009 | Low | E2E coverage | Cancel spec's runner-gone / `runnerDir` checks always pass |
| KI-010 | Low | E2E coverage | Blocked spec: dead `STANDARD`-artifact loop; secret check looks only for the raw value |
| KI-011 | Low | Docs | Egress-spike alert fires on any block when the previous day had none |
| KI-012 | Low | Tests | `vitest.config.ts` comment says runs go one at a time; E2E worker runs two |
| KI-013 | Low | Tests | `createTestApi` casts `extra.queue` to `FakeQueue` without checking |
| KI-014 | Low | Retention | A retention pass has no time limit and the S3 client has no request timeout |
| KI-015 | Low | Docs | Spec checkboxes for Tasks 21–22 are unticked (spec file is read-only) |
| KI-016 | Env | Dev machine | Stale sandbox profile in `$TMPDIR` fails `sandbox-preflight.test.ts` |
| KI-017 | Env | Dev machine | Default shell Node 22.13 is below `engines` and its Corepack is broken |

---

## KI-001 — Live E2E gate has not been run
- **Severity:** High (Milestone E acceptance: "live suite green 3 times in a row").
- **Where:** `scripts/e2e-live-gate.sh`, `tests/e2e/platform-*.spec.ts`, `tests/e2e/platform-injection.spec.ts`.
- **What:** Live mode (`E2E_MODE=live`: real model + Stagehand) has never run end to end; there was no
  `ANTHROPIC_API_KEY` in the implementation environment. The prompt-injection spec (Task 21 step 6) runs only in
  live mode.
- **Risk:** Some specs identify criteria by check kind (`numeric_compare`, `collection_contains`); a real model
  may phrase criteria differently. Loosen only assertions that pin model wording, never platform guarantees
  (`verdictSource`, blocking reasons, secret hygiene).
- **To close:** `pnpm infra:up && ANTHROPIC_API_KEY=… ./scripts/e2e-live-gate.sh`, then record the date and result in
  README "Status".

## KI-002 — Chromium's sandbox cannot start in the compose worker
- **Severity:** High for deployment (pre-existing; see README "Status").
- **What:** Docker's default seccomp profile denies the user namespaces Chromium's sandbox needs, so real
  exploration and the Playwright rerun fail in the `worker` container (`ERRORED / BROWSER_PROVIDER`). The E2E suite
  therefore runs the worker as a local process.
- **To close:** decide the open security question — a seccomp profile allowing user namespaces for the worker
  (preferred), `cap_add: SYS_ADMIN`, or `--no-sandbox` (not recommended) — then run the E2E suite against the
  compose worker.

## KI-003 — `test_run_duration_seconds` attributes the first stage of each job wrongly
- **Severity:** Medium.
- **Where:** `apps/worker/src/run-context.ts` (`stageStartedAt` seeded with `now()` when the context is built).
- **What:** Each analyze job records a near-zero `QUEUED` sample (not the real queue wait); each execute job records
  a near-zero `PLANNING` sample, making `PLANNING` bimodal; `AWAITING_CONFIRMATION` is never observed.
- **Fix:** seed from the run's last lifecycle change time (e.g. a `lifecycleChangedAt` / `updatedAt` column), or skip
  the first observation of each job.

## KI-004 — `runs_reaped_total` undercounts when a reaper pass fails midway
- **Severity:** Medium.
- **Where:** `apps/worker/src/jobs/reap.ts` (the counter is incremented once, after the whole pass).
- **What:** If the pass throws after reaping some runs, `test_runs_total` already counts them but `runs_reaped_total`
  does not.
- **Fix:** increment `runsReaped` per run, next to the `testRuns` increment.

## KI-005 — Worker metrics port published on all interfaces; fixed host port blocks scaling
- **Severity:** Medium (dev compose only).
- **Where:** `infra/compose/docker-compose.yml` (`ports: ["9464:9464"]` on `worker`).
- **What:** Exposes unauthenticated metrics on every host interface (the ops doc says the port must stay private),
  and a fixed host port makes `docker compose up --scale worker=N` fail.
- **Fix:** `127.0.0.1:9464:9464`, or drop the mapping and scrape over the compose network.

## KI-006 — CI destructive spec never exercises the executor's DOM-level guard
- **Severity:** Medium (test gap on a safety control).
- **Where:** `tests/e2e/support/scenarios.ts` (deletion scenario: `destructive: true`, description contains "Delete").
- **What:** The planner's deterministic blocking stops the plan first, so `executor.enforcePolicy` — the guard that
  checks the actual element before clicking, which is what protects against prompt injection — never runs in CI.
- **Fix:** add a scenario whose planned step is `destructive: false` with a neutral description (e.g. "Click the
  button in the danger zone") that resolves to `[data-testid="delete-account"]`; expect
  `BLOCKED / DESTRUCTIVE_ACTION_NOT_AUTHORIZED` and zero delete clicks.

## KI-007 — Run log scope is released outside a `finally` in `dispose()`
- **Severity:** Low.
- **Where:** `apps/worker/src/run-context.ts` (`releaseLog?.()` at the end of `dispose()`).
- **What:** If `unwatch()` (or anything before the release) throws, the run's log scope stays registered for the
  life of the process.
- **Fix:** wrap the body of `dispose()` in `try { … } finally { releaseLog?.(); }`.

## KI-008 — Logger prints shared references as `"[Circular]"`; errors lose `stack` / `cause`
- **Severity:** Low.
- **Where:** `packages/config/src/logger.ts` (`stringify`, `serializeError`).
- **What:** The `seen` set marks any repeated object, so `{ a: x, b: x }` logs `b` as `"[Circular]"`.
  `serializeError` keeps only `name`, `message`, `code`, which makes ERRORED runs harder to debug.
- **Fix:** track the ancestor stack instead of every seen object; include a (redacted) `stack` and a serialized
  `cause` chain.

## KI-009 — Cancel spec's runner-gone / `runnerDir` checks always pass
- **Severity:** Low.
- **Where:** `tests/e2e/platform-cancel.spec.ts`.
- **What:** The run is cancelled during `EXPLORING`, before any Playwright runner or workspace exists, so those
  assertions are vacuous. Runner teardown on cancel is covered only by unit tests.
- **Fix:** add a case that cancels during `RUNNING_PLAYWRIGHT` (e.g. a slow page only on the rerun path) and assert
  the runner process and workspace are gone.

## KI-010 — Blocked spec: dead loop; secret check looks only for the raw value
- **Severity:** Low.
- **Where:** `tests/e2e/platform-blocked.spec.ts`.
- **What:** The loop over `STANDARD` artifacts never runs (the next assertion requires all artifacts to be
  `SECRET_BEARING`). The absence checks search only for the raw secret, not its URL-encoded, base64 or
  JSON-escaped forms, which the redactor also handles.
- **Fix:** drop or repurpose the loop; check every encoded form, as `compiled-rerun.test.ts` does for traces.

## KI-011 — Egress-spike alert fires on any block when the previous day had none
- **Severity:** Low.
- **Where:** `docs/operations.md` (egress-spike PromQL).
- **Fix:** add an absolute floor, e.g. `… > 5 * … and sum(rate(egress_blocked_total[10m])) > 0.1`.

## KI-012 — Misleading comment about E2E run concurrency
- **Severity:** Low.
- **Where:** `vitest.config.ts` (`e2e` project comment) vs `tests/e2e/support/stack.ts` (`WORKER_CONCURRENCY: "2"`).
- **Fix:** correct the comment (spec files run one at a time; the worker may run two jobs).

## KI-013 — `createTestApi` casts `extra.queue` without checking
- **Severity:** Low.
- **Where:** `apps/api/src/test-support.ts`.
- **Fix:** type `extra.queue` as `FakeQueue`, or return the queue as `RunQueue`.

## KI-014 — Retention pass has no time limit; S3 client has no request timeout
- **Severity:** Low (retention now has its own queue, so it can no longer block the reaper).
- **Where:** `apps/worker/src/jobs/retention.ts`, `packages/storage/src/s3-storage.ts`.
- **What:** A hung S3 call can stall a retention pass indefinitely, delaying the next day's pass.
- **Fix:** a per-pass deadline in `retentionJob`, and request/connection timeouts on the S3 client.

## KI-015 — Spec checkboxes for Tasks 21–22 are unticked
- **Severity:** Low (documentation).
- **Where:** `docs/ai-testing-platform-implementation-plan.md` is read-only on disk, so it was not edited; the
  README records Milestone E status and deviations instead.
- **To close:** make the file writable and tick Task 21 steps 1–5, 7–9 and Task 22 steps 1–6 (step 6 of Task 21
  after KI-001).

## KI-016 — Stale sandbox profile in `$TMPDIR` fails `sandbox-preflight.test.ts`
- **Severity:** Environment (this machine only).
- **What:** `platform-sandbox-preflight-h4hlZ1`, created 2026-09-26 12:57 by an earlier run, makes the "leaves no
  profile behind" assertion fail. The suite passes 29/29 with a fresh `TMPDIR`.
- **To close:** `rm -rf "$TMPDIR"/platform-sandbox-preflight-h4hlZ1`.

## KI-017 — Default shell Node is below the repo's minimum
- **Severity:** Environment (this machine only).
- **What:** The default `node` is 22.13.1 (`engines` requires ≥ 22.18), and its Corepack fails with "Cannot find
  matching keyid". Milestone E was built and tested with Node 24.15.0 and Homebrew's pnpm 10.28.0.
- **To close:** `nvm alias default 24` (or install ≥ 22.18), and `corepack enable` on that version.
