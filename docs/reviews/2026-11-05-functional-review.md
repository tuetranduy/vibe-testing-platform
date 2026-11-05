# Requirements and functional review — 2026-11-05

## Assessment

The main V1, V1.1 and V1.2 features are implemented. The largest remaining product risk is the reliability of
discovery on unfamiliar sites: locating the intended control, capturing short-lived results, and distinguishing
an incomplete flow from a failed assertion. The presence of a report or a generated test does not by itself mean
that every requested behavior was exercised.

This review found and fixed five reproducible defects. It also identified the follow-up work below. Changes are
in the checkout; the already-running Docker application was inspected but was not rebuilt or redeployed.

## Requirements used

- `docs/ai-testing-platform-implementation-plan.md`, including Revision 3 and its subsequent amendments.
- The criteria-editing, suggested-tests, destructive-actions and LLM-settings specs under `docs/superpowers/specs/`.
- `2026-09-29-v1.1-design.md` and `2026-09-30-v1.2-design.md`.
- `2026-10-07-generated-inputs-no-redaction-design.md` and the October 7 D3 amendment in the plan.

Later decisions take precedence: missing fill values are generated, run-secret values may appear in evidence,
semantic criteria can receive explicitly labelled AI judgments, and only critical criteria decide the verdict.
Older descriptions of blocking missing inputs, artifact reveal, and exclusively deterministic PASS/FAIL are
historical. They should not be used as today's acceptance criteria.

## Feature coverage

“Implemented” below means routes, runtime code and relevant automated coverage exist; it does not mean every
site, provider or production deployment has been certified.

| Requirement | Assessment | Evidence / qualification |
|---|---|---|
| Create, review, edit checks, confirm, cancel | Implemented | API lifecycle/criteria tests, web form/review tests, HTTP acceptance suite |
| Blank requirement → survey → choose a test | Implemented | Survey and suggestion routes/stages; selection acceptance tests |
| Browser exploration, evidence, deterministic verification | Implemented; reliability needs continued work | Engine, sandbox and integration tests; recent live-site reports still contain missing/unverified facts |
| Generated Playwright test and reconciliation | Implemented; asynchronous-click defect fixed | Compiler, real runner and reconciliation tests; see fix 1 |
| Generated missing inputs and full-HD execution | Implemented; password fallback fixed | Input-generator/executor tests, viewport configuration; see fix 4 |
| Users, roles, ownership, sessions | Implemented | Auth/repository tests; signed in and inspected the local application |
| Critical/non-critical criteria | Implemented | Requirement contracts, verifier/reporting tests and review UI |
| Saved data and credentials | Implemented | Tenant-scoped repositories, settings components and API tests |
| Manual saved-test reruns | Implemented | Rerun API/worker tests; previous reviewed helper template remains accepted |
| Markdown and printable reports | Implemented | Report API, Markdown renderer and printable UI tests; PDF uses the browser print dialog by design |
| Usage dashboard, lookup cache, multiple scenarios | Implemented | Usage/cache routes and tests; planner/executor/compiler scenario coverage |
| Suites, comparison, scheduled execution | Implemented; retry defects fixed | Suite/schedule/comparison tests; see fixes 2–3 |
| API tokens, CLI, GitHub Action, JUnit | Implemented | Scope/proxy/client/reporting tests; GitHub execution was not verified in this review |
| Deadlines, lost workers, retention, isolation | Implemented | Orchestrator, reaper, sandbox, runner and integration tests |

## Fixed defects

### 1. Generated clicks could cancel a successful asynchronous submission — high

**Trigger:** a click sends a fetch/XHR, followed by an explicit navigation, such as registration followed by login.
Exploration already waited for these requests, but the generated test navigated immediately. This is the open
generated-test half of KI-049.

**Change:** generated tests subscribe to main-frame fetch/XHR events before each click, then wait for the tracked
requests to finish or fail, for up to five seconds after the load wait. Images and iframe traffic are excluded.
The wait removes its listeners when it finishes. The initial attempt using `waitForLoadState("networkidle")`
proved insufficient in a real-browser regression because the pre-click idle state could satisfy it immediately.

**Verification:** the compiler's actual output runs in the real Playwright child process through the egress proxy
against `/newsletter`. Its 800 ms submission completes before navigation. Additional browser tests cover a stuck
fetch's time bound and ignoring a stuck image. Compiler snapshots, source guard and generated-source typechecking
cover the added helper call.

**Compatibility:** the exact previous reviewed helper template is still accepted, and the runner always writes
the current trusted helpers. Existing saved test source remains pinned: regenerate and replace a suite entry to
give an older saved test the new click tracking. The wait is bounded, so a request taking longer than five seconds
can still be interrupted by later navigation.

### 2. Retrying an accepted suite run depended on mutable configuration — medium

**Trigger:** send a suite run with an idempotency key, remove its credential profile or entries, then retry the
same request. It returned `422` or `SUITE_EMPTY` instead of the accepted run.

**Change:** after checking access to the suite, replay an existing key before resolving entries, tests and
credentials. Request-hash and owner checks still reject a different request or caller.

**Verification:** API regression deletes the requested profile and then the last entry; both retries return the
original suite/child IDs and enqueue no additional work.

### 3. A redelivered schedule could execute twice — medium

**Trigger:** a scheduled job is delivered again in a later minute after its first suite run has finished. The
idempotency key used delivery time, giving the same firing a new key.

**Change:** derive the key from the scheduled due time; retain delivery time only for calls with no due time.

**Verification:** fire, complete the children, advance delivery time one minute, and redeliver the original due
time. It returns the original suite run and queues no additional children.

### 4. Fallback passwords ignored the field's maximum length — medium

**Trigger:** the model returns no usable value, or the fake engine generates a password for a field shorter than
16 characters. The fallback always produced 16 characters, which could be rejected or truncated by the browser,
leaving later password reuse inconsistent.

**Change:** fit the fallback length before shuffling, retaining upper/lowercase, digits and symbols when at least
four characters fit. Apply the same field-fitting rules as other generated values.

**Verification:** a 12-character field receives a matching password with all four character classes, both with
no model and with an empty model answer.

### 5. A hung HTTP poll ignored the CLI's wait deadline — medium

**Trigger:** a suite-run GET request never responds. The client checked its deadline only between completed
requests, so `--timeout-minutes` could leave a CI job waiting indefinitely.

**Change:** each poll receives the remaining deadline and an abort signal. A deadline promise also bounds custom
transports that ignore cancellation. Expiry returns exit code 3 and preserves the last received progress.

**Verification:** a regression first receives a running suite, then uses a transport that never resolves. The
client aborts at the deadline, retains the suite-run ID and last progress, and reports timeout rather than a
platform error. All 13 client/CLI/Action unit tests and the client's TypeScript checks pass.

## Follow-up priorities

| Priority | Gap / improvement | Why it matters | Concrete next step |
|---|---|---|---|
| High | Improve control selection and transient-result capture | The inspected recent `demo.klarna.dev` failed run had 1 PASS, 1 FAIL and 3 INCONCLUSIVE results, including missing popup evidence. Its saved flow repeated a product-link click. This is evidence of a problematic execution, not proof of its root cause or of a site defect. | Turn that flow into a local fixture; assert the add action happened, the intended product context was reached, and the popup was captured immediately. Keep deterministic provenance rules. |
| High | Evaluate the AI criterion judge | The D3 amendment lets `AI_JUDGMENT` decide PASS/FAIL, but `evals/run-evals.ts` only registers compiler, planner and survey suites (KI-046). | Add relevant/irrelevant-page, wrong-product, missing-subject and undecidable examples, then score every supported judgment model before relying on it for release decisions. |
| Medium | Make history current and searchable across all runs | `RunHistory.tsx` fetches on mount/retry/owner change; filters search loaded pages only. An open list can keep stale active statuses, and an older matching run requires loading pages manually. | Add refresh/polling with request cancellation, plus API-side search/status filters with cursor pagination. Test pagination responses arriving after an owner change. |
| Medium | Preserve non-click actions in saved tests | Exploration's `safeAction` supports `other` actions such as hover/doubleClick/scrollIntoView, while the compiler emits every successful `act` as a click. | Persist the performed action method and replay it explicitly, or mark unsupported methods uncompileable. Add a hover-to-open-menu regression. |
| Medium | Enforce all generated-field constraints | `fitToField` handles options and maximum length; it does not validate type, pattern, min/max or disabled options before filling. | Validate generated values against the recorded field constraints; add number/date/pattern and disabled-select fixtures, including the no-model fallback. |
| Medium | Add browser acceptance tests for the platform UI | Current platform E2E tests use HTTP and persistence; UI coverage uses component mocks. Proxy/cookie/navigation integration can fail while both layers pass separately. | Cover sign-in → create → review → live completion → report, plus saved rerun, suite execution, session expiry and reconnect in a real browser. |
| Low | Reconcile status documentation | README milestone prose still describes removed redaction/reveal rules and missing-input blocking. The issue tracker also says there is no remote, although `origin` now exists. | Keep the dated requirements precedence above visible; verify GitHub CI/Action history separately before closing KI-025/KI-036. |

## Validation

The initial test attempt found a missing local Playwright Chromium build. Installed the project's pinned browser
build and reran the checks.

| Check | Result |
|---|---|
| `pnpm typecheck` | Passed |
| `pnpm test` | Passed: 2,653 Vitest tests plus 22 demo-shop browser tests; 11 opt-in S3 tests skipped in this command |
| S3 storage tests with the local S3 endpoint configured | Passed: 92 tests, including all 11 previously skipped tests |
| `pnpm test:integration` | Passed: 35 tests |
| `pnpm test:e2e` | Passed after the fixes: 31 tests, 1 live-only test skipped |
| `pnpm --filter @platform/web build` | Passed |
| Client/CLI/Action tests and typecheck after the timeout fix | Passed: 13 tests |
| `git diff --check` | Passed |

The CLI deadline gap was reproduced without network access before fixing it: a fetch stub that never resolves
left a 10 ms `waitForSuiteRun` deadline pending beyond 150 ms. The added regression now passes.

No paid-model evaluation or new live-site test was started. The UI inspection used existing local run reports;
the automated execution uses local fixtures and scripted models. Provider-specific quality and a rebuilt
production/Compose deployment remain outside the verification performed here.
