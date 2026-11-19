# Exploration and Testing Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise the share of criteria the platform decides correctly — fewer INCONCLUSIVE runs, no hidden false PASSes — and measure it on more than one site.

**Architecture:** Measurement first (a seeded-bug demo shop and a multi-site benchmark runner that reports bug detection, decided rate, false FAILs, shallow passes and rerun agreement), then exploration changes inside the executor (direct name lookup, an indexed recovery choice, sign-in walls, site error pages, bounded replanning, a fallback model), then the testing phase (a flaky-rerun classification, fresh made-up usernames). Every new verdict path is deterministic and reported with its own reason code.

**Tech Stack:** TypeScript, Zod 4, Playwright (playwright-core 1.56), Stagehand adapter, Vitest 4, plain Node ESM demo shop.

**Spec:** the suggestions of 2026-11-19 (this conversation), grounded in `evals/e2e-unclear/RESULTS-2026-11-06-frontends-demo.md`, `docs/reviews/2026-11-05-browser-use-evaluation.md`, `docs/reviews/2026-11-05-functional-review.md`, KI-073, KI-074, KI-076, KI-077 and WS2/WS3 of `docs/superpowers/plans/2026-11-06-autonomous-unclear-requirements.md`. Already done and dropped from scope: non-click replay (`actMethod`), generated-field constraints (`fitToField`).

## Global Constraints

- Safety unchanged: every action a new path proposes goes through `enforcePolicy` / `assertActionAllowed`, `applyBlocking`, the host allowlist and the redactor. A replan may never block a criterion the original plan did not.
- No PASS without deterministic evidence (reconciliation rule R35) — new rules only turn non-PASS results into BLOCKED/INCONCLUSIVE with a clearer reason, or PASS/FAIL into INCONCLUSIVE.
- Contract additions are optional fields or new enum members; stored rows (JSON) need no migration; old reports still parse.
- Saved tests stay accepted: a changed helper template keeps the previous source as an accepted version.
- Code reads like its neighbours: header comments state behaviour and the KI it answers; one-line JSDoc on exported functions.
- New reason text (exact):
  - `SIGN_IN_REQUIRED`: "The site asked to sign in for an action this check needs; add credentials to test it"
  - `SITE_ERROR`: "The site showed a server error page where this was checked"
  - `RERUN_FLAKY`: "The generated test passed on one rerun and failed on another"
- Limits: replans `MAX_REPLANS = 2` per scenario, `MAX_REPLAN_STEPS = 15`; rerun attempts `MAX_RERUN_ATTEMPTS = 2`; a second rerun only when at least `MIN_RETRY_MS = 15_000` remain.

## Review Focus

1. A sign-in prompt the user *meant* to open ("Open the login dialog", "Click Sign in") — must not block anything (Task 4 test `ignores a step that asks for sign-in`).
2. A site whose ordinary content mentions "error" (a 404 page for a product, a help article "Common errors") — must not read as a server error page (Task 5 test `does not flag a page that only mentions errors`).
3. A replan that re-plans a destructive or login step, or drops a checkpoint — must be rejected, exploration stops as before (Task 6 tests `rejects a replan that drops a checkpoint` / `that blocks a criterion`).
4. A rerun that fails twice the same way — still a confirmed FAIL / disagreement, never FLAKY (Task 8 test `two identical failures stay ASSERTION_FAILED`).
5. The fallback model's provider has no key — the run keeps its primary model and logs a warning, never errors at start (Task 7 test `skips a fallback without a key`).

---

### Task 1: Contract additions for the new outcomes

**Files:**
- Modify: `packages/contracts/src/run.ts` (BlockReason += `SIGN_IN_REQUIRED`; InconclusiveReason += `SITE_ERROR`, `RERUN_FLAKY`)
- Modify: `packages/contracts/src/results.ts` (RerunOutcome += `FLAKY`; ExplorationOutcome += `revisedPlan?: TestPlan`)
- Modify: `packages/contracts/src/exploration.ts` (ExplorationStep += `signInPrompt?: boolean`, `siteError?: string`)
- Modify: `packages/contracts/src/events.ts` (event `plan.revised`)
- Modify: `packages/contracts/src/report-text.ts`, `apps/web/components/report-format.ts` (texts)
- Test: `packages/contracts/src/contracts.test.ts`

**Interfaces — Produces:**
- `ExplorationStep.signInPrompt?: boolean` — set on an `act` step whose click opened a sign-in prompt.
- `ExplorationStep.siteError?: string` (max 200) — set on a `checkpoint` step taken on a server error page; the page's error heading.
- `ExplorationOutcome.revisedPlan?: TestPlan`.
- event `plan.revised` payload `{ scenarioId: string; afterStepId: string; stepCount: number }`.
- `RERUN_OUTCOME_TEXT.FLAKY = "Passed on one rerun and failed on another"`.

- [ ] Step 1: tests in `contracts.test.ts`: `STATUS_REASON_TEXT` has an entry for every `StatusReason` (already enforced by the `Record` type — add parse tests): a step with `signInPrompt: true` and a checkpoint with `siteError: "500 Internal Server Error"` parse; an outcome with `revisedPlan` parses; `plan.revised` event parses.
- [ ] Step 2: run `pnpm --filter @platform/contracts test` → FAIL.
- [ ] Step 3: add the fields and texts (exact text: Global Constraints).
- [ ] Step 4: `pnpm --filter @platform/contracts test && pnpm -r typecheck` → PASS (fix every exhaustive `Record<RerunOutcome|StatusReason, …>` the typecheck names).

### Task 2: Look up a named control directly before asking the model

**Files:**
- Modify: `packages/testing-engine/src/exploration/recorder.ts` (add `exactNamedControl`)
- Modify: `packages/testing-engine/src/exploration/executor.ts` (`RecorderPort.exactControl?`, `act`)
- Test: `packages/testing-engine/src/exploration/executor.test.ts`, `tests/integration/explore-stage.test.ts` (real Chromium)

**Interfaces — Produces:** `exactNamedControl(page: Page, name: string, roles: readonly string[]): Promise<string | null>` — the selector of the one visible, hittable element of those roles whose accessible name equals `name` (Playwright `getByRole(role, { name, exact: true })`); null when there are none or several.

- [ ] Step 1: executor tests: `"Click the 'New User' button"` with a recorder whose `exactControl` returns a selector → no `session.observe` call, an `observe` step recorded with `llm: null` and the instruction prefixed `By name: `, then the `act`; `exactControl` returns null → `observe` is called as before; a step with no named control (`"Open the cart"`) → `exactControl` never called; a `search` submit (`searchField` set) → never called.
- [ ] Step 2: integration test (real Chromium, `setContent`): two buttons "Login" and "Login with Google" → `exactNamedControl(page, "Login", ["button"])` returns the first; two "Add to cart" buttons → null.
- [ ] Step 3: run both → FAIL.
- [ ] Step 4: implement; in `act`, before `locate`, only when `searchField === undefined`, `observeInstruction === step.description`, no pointer method, and `namedControl(step.description)` is non-null.
- [ ] Step 5: `pnpm --filter @platform/testing-engine test -- executor && pnpm test:integration -- explore-stage` → PASS.

### Task 3: An indexed element list for the "way there" recovery

**Files:**
- Modify: `packages/testing-engine/src/survey/interactive.ts` (export `CANDIDATES_SCRIPT`, `CandidateSchema`, type `Candidate`)
- Create: `packages/testing-engine/src/exploration/way-there.ts`
- Modify: `packages/testing-engine/src/exploration/executor.ts` (`act` recovery; `ExplorationDeps.wayThere?`)
- Test: `packages/testing-engine/src/exploration/way-there.test.ts`, `executor.test.ts`

**Interfaces — Produces:**
- `interface WayThere { choose(input: { goal: string; url: string; candidates: { index: number; label: string; href: string }[] }, signal: AbortSignal): Promise<number | null> }`
- `createWayThere(ctx: StageContext): WayThere | null` (null without `ctx.llm`); one structured call, schema `{ index: number }` where `-1` means none; reasoning `minimal` when the run's is `default`; max 400 tokens.
- `wayThereCandidates(raw: Candidate[]): Candidate[]` — click candidates only, filtered by `assertActionAllowed(…, { allowDestructive: false })` and the sign-out/subscribe words `canExplore` uses, first 40.

- [ ] Step 1: tests: `wayThereCandidates` drops fills, "Delete account", "Log out"; `choose` returns the index the model answered, null for -1 or an index out of range; executor: when the step's control is not found and `wayThere` is given, the executor evaluates the candidates, clicks the chosen one (policy-checked, recorded `observe` with `By index:` instruction + `act`), then looks for the step's control again; with `wayThere` null the existing observe-based recovery runs.
- [ ] Step 2: run → FAIL. Step 3: implement (the chosen candidate's selector → `recorder.record` / `describe` → `Located`). Step 4: run → PASS.

### Task 4: Recognise a sign-in wall (KI-073)

**Files:**
- Create: `packages/testing-engine/src/exploration/sign-in-prompt.ts`
- Modify: `packages/testing-engine/src/exploration/executor.ts` (`click`)
- Modify: `packages/testing-engine/src/verification/verifier.ts`
- Test: `sign-in-prompt.test.ts`, `executor.test.ts`, `verifier.test.ts`

**Interfaces — Produces:**
- `SIGN_IN_STATE_SCRIPT: string` → `{ passwordFields: number; url: string }` (visible `input[type=password]`).
- `openedSignIn(before: SignInState, after: SignInState, stepDescription: string): boolean` — true when visible password fields went from 0 to ≥ 1, or the path changed to one matching `/(?:^|\/)(?:log-?in|sign-?in|account\/login|auth)(?:\/|$)/i`; false when the step itself asks for sign-in (the verifier's `LOGIN_WORDS` or "register" / "sign up" / "account").
- Verifier rule 3b: when the rule result (rules 4–6) is not PASS, the criterion has no `authenticated` precondition, and a golden `act` step with `signInPrompt` precedes one of its checkpoints → `BLOCKED / SIGN_IN_REQUIRED`, actual `"Step <PS-n> opened a sign-in prompt: the site asks to sign in for this action"`.

- [ ] Step 1: tests: `openedSignIn` true for 0→1 password fields, true for `/account/login`, false when the step says "Click Sign in"; executor: a click step whose page shows a password field afterwards records `signInPrompt: true`, a `login` step never does; verifier: FAIL after a sign-in prompt → BLOCKED/SIGN_IN_REQUIRED; PASS after it stays PASS; a criterion with an `authenticated` precondition is untouched.
- [ ] Step 2: run → FAIL. Step 3: implement (state read before and after the click, both `.catch(() => null)` → no flag). Step 4: run → PASS.

### Task 5: Recognise a server error page (KI-074)

**Files:**
- Create: `packages/testing-engine/src/exploration/site-error.ts`
- Modify: `executor.ts` (`checkpoint`), `verifier.ts`
- Test: `site-error.test.ts`, `executor.test.ts`, `verifier.test.ts`

**Interfaces — Produces:**
- `SITE_ERROR_SCRIPT: string` → `{ title: string; headings: string[]; text: string }` (first 3 h1/h2, first 600 chars of body text).
- `siteErrorOf(page: { title: string; headings: string[]; text: string }): string | null` — the matching title or heading, when the title or a heading matches `/^\s*(?:error\s*)?5\d\d\b|internal server error|service unavailable|bad gateway|gateway time-?out|something went wrong|application error|an error occurred/i`, or the whole body text is under 300 characters and contains one of those phrases.
- Executor: at a checkpoint, a match waits for network quiet (3 s) and reads again; still matching → the checkpoint step gets `siteError`.
- Verifier rule 6b: a non-PASS result whose facts were captured at a checkpoint step with `siteError` → `INCONCLUSIVE / SITE_ERROR`, actual `"The site showed an error page (<siteError>)"`.

- [ ] Step 1: tests: `siteErrorOf` matches `"500 | Internal Server Error"`, `"Something went wrong"`, `"[PATCH] … 500"` heading; not `"Common errors when ordering"`, not `"Page not found"`, not a long product page mentioning "error"; executor records `siteError` only when the second read still matches; verifier: FAIL at an error-page checkpoint → INCONCLUSIVE/SITE_ERROR, PASS unchanged.
- [ ] Step 2–4: fail, implement, pass.

### Task 6: Bounded replanning after a failed step (WS3.3)

**Files:**
- Create: `packages/testing-engine/src/exploration/replanner.ts`
- Modify: `executor.ts` (`exploreScenario`, `execute`, `ExplorationDeps.replanner?`), `explore-stage.ts` (wire `createReplanner(ctx.llm)`), `orchestrator/orchestrator.ts` (use and save `revisedPlan`)
- Test: `replanner.test.ts`, `executor.test.ts`, `orchestrator.test.ts`

**Interfaces — Produces:**
- `interface ReplanInput { requirement: NormalizedRequirement; scenario: TestScenario; done: PlannedStep[]; failed: PlannedStep; remaining: PlannedStep[]; url: string; inventory: PageInventory | null; testDataKeys: string[]; secretNames: string[]; firstId: number; targetUrl: string; policy: ActionPolicy }`
- `interface Replanner { replan(ctx: StageContext, input: ReplanInput, signal: AbortSignal): Promise<PlannedStep[] | null> }`
- `createReplanner(llm: LlmClient | null): Replanner | null`
- `validateReplan(output: { steps: PlannerStepOutput[] }, input: ReplanInput): { ok: true; steps: PlannedStep[] } | { ok: false; issues: string[] }` — the new steps capture exactly the checkpoints `failed` + `remaining` still had to capture, each once, `before*` before `after*`; every `fill` has an `inputRef`; criterion ids ⊆ the scenario's; no `login` unless `failed`/`remaining` had one; at most `MAX_REPLAN_STEPS`; ids `PS-<firstId + i>`.
- `replan` = one `generateStructured` call (schema `{ steps: PlannerStepOutputSchema[] }`, `check` = `validateReplan`), then `applyBlocking` on the result: any blocked criterion → null. Every error but cancellation → null.
- Executor: a planned step that ends its scenario with `Stop("COMPLETED")` (not policy, not budget, not a destructive step) is replanned, at most `MAX_REPLANS` per scenario: remaining steps replaced, the failed one kept, `judgeSchedule` recomputed, `plan.revised` published, and `execute()` returns `revisedPlan` (validated with `TestPlanSchema`) when any scenario changed.
- Orchestrator: `const effective = exploration.revisedPlan ?? plan`; saved with `ports.savePlan`, then used for verify, generate and report.

- [ ] Step 1: tests (replanner): valid output → ids from `firstId`; drops a checkpoint → issue; captures one twice → issue; adds a login → issue; a step the policy blocks → `replan` returns null.
- [ ] Step 2: tests (executor): a click that fails twice with a replanner returning two steps → those steps run, outcome has `revisedPlan` whose scenario lists the failed step then the new ones, one `plan.revised` event; replanner returns null → exploration stops as today; a third failure after two replans stops; a BLOCKED_BY_POLICY stop is never replanned.
- [ ] Step 3: test (orchestrator): with `revisedPlan` the verify/generate/report stages get it and `savePlan` is called twice.
- [ ] Step 4–5: implement; run → PASS.

### Task 7: A fallback model on provider errors

**Files:**
- Modify: `packages/llm/src/llm-client.ts` (`LlmClientOptions.fallback?`)
- Modify: `packages/config/src/env.ts` (`LLM_FALLBACK_MODEL`, export `providerOfModel`)
- Modify: `apps/worker/src/run-llm.ts`
- Test: `packages/llm/src/llm-client.test.ts`, `packages/config/src/env.test.ts`, `apps/worker/src/run-llm.test.ts`

**Interfaces — Produces:**
- `LlmClientOptions.fallback?: { transport: LlmTransport; model: string }`. When the primary request gives up (non-retryable transport error, retries exhausted, or the next backoff would pass the deadline) the same request goes to the fallback, and every later request of the client too (sticky). A fallback answer is priced and recorded under its model (as `response.fallbackModel`). Aborts and invalid output never switch.
- `providerOfModel(model: string): "anthropic" | "gemini" | "deepseek" | null` (by `MODEL_PREFIXES`).
- `LLM_FALLBACK_MODEL` (optional). The worker adds the fallback when it differs from the run's model and its provider has a key (saved or env); otherwise warns `"fallback model has no key; runs keep their own model"` and builds no fallback. No fallback with the test transport seam.

- [ ] Step 1: tests: a 503 on every primary attempt → the fallback answers, the record names the fallback model; the next call goes straight to the fallback; a 400 invalid-output answer does not switch; abort does not switch; `providerOfModel("gemini-3.5-flash") === "gemini"`; worker `skips a fallback without a key`.
- [ ] Step 2–4: fail, implement, pass.

### Task 8: Classify a flaky rerun

**Files:**
- Modify: `packages/testing-engine/src/playwright-runner/run-stage.ts`
- Create: `packages/testing-engine/src/playwright-runner/attempts.ts`
- Modify: `reconciliation/reconcile.ts`, `reporting/rerun-only.ts`, `apps/web/components/report-format.ts`
- Test: `attempts.test.ts`, `reconcile.test.ts`, `rerun-only.test.ts`, run-stage test

**Interfaces — Produces:**
- `combineAttempts(a: Record<string, RerunOutcome>, b: Record<string, RerunOutcome>): Record<string, RerunOutcome>` — same → same; PASSED + ASSERTION_FAILED → FLAKY; one definite (PASSED / ASSERTION_FAILED) + NOT_REACHED / UNAVAILABLE → the definite one; otherwise the second.
- Run stage: when the first attempt's status is FAILED and `rerunTimeoutMs(ctx)` after it still leaves ≥ `MIN_RETRY_MS`, the workspace is removed and the test runs once more; per-criterion outcomes combined; status FAILED if any outcome is ASSERTION_FAILED or FLAKY, else PASSED/ERRORED as the second attempt; evidence of both attempts kept; duration summed.
- Reconcile: PASS/FAIL (not `aiJudged`) with FLAKY → `INCONCLUSIVE / RERUN_FLAKY`. Rerun-only: FLAKY → `INCONCLUSIVE / RERUN_FLAKY`.

- [ ] Step 1: tests: the `combineAttempts` table, incl. `two identical failures stay ASSERTION_FAILED`; reconcile FLAKY rows; run stage runs twice on FAILED, once on PASSED, once when too little time is left.
- [ ] Step 2–4: fail, implement, pass.

### Task 9: Fresh made-up usernames on every execution (KI-077 remainder)

**Files:**
- Modify: `packages/testing-engine/src/exploration/input-generator.ts` (username fields get `qa_<6 random [0-9a-z]>`)
- Modify: `packages/testing-engine/src/compiler/helpers-template.ts` (`refreshEmails` also refreshes `qa_[0-9a-z]{6}`; previous source kept as `ACTION_HELPERS_V3_SOURCE`, accepted)
- Test: `input-generator.test.ts`, `helpers-template.test.ts`

- [ ] Step 1: tests: a field labelled "Username" (no model) gets `/^qa_[0-9a-z]{6}$/`, a new one per run; `refreshEmails({ a: "qa_abc123", b: ["qa_abc123"] })` gives both the same new token; a saved test using the previous helper source is still accepted.
- [ ] Step 2–4: fail, implement, pass.

### Task 10: Mark a pass that rests on one broad check

**Files:**
- Modify: `packages/contracts/src/assumptions.ts` (`PASSED_ON_SHALLOW = "Passed (one broad check only)"`, `passedOnShallowCheck`)
- Modify: `apps/web/components/ReportSummary.tsx`, `PrintableReport.tsx`, `packages/testing-engine/src/reporting/markdown.ts`
- Test: `packages/contracts/src/contracts.test.ts`, `ReportSummary` test, `markdown.test.ts`

**Interfaces — Produces:** `passedOnShallowCheck(report: { verdict; requirement: { criteria; intent? } | null }): boolean` — PASSED, intent clarity `vague` or `site_wide`, and at most one critical criterion. The assumed-checks label wins when both apply.

- [ ] Steps 1–4: test (FD-11 shape → true; `specific` → false; two criteria → false), fail, implement, pass.

### Task 11: Seeded bugs and fixture pages in the demo shop

**Files:**
- Modify: `tests/fixtures/demo-shop/src/server.js`, `server.d.ts`
- Test: `tests/fixtures/demo-shop/demo-shop.test.ts`

**Produces (exact):** `KNOWN_BUGS = ["empty_cart", "wrong_total", "search_ignores_query", "login_no_error", "add_to_cart_noop", "price_mismatch", "product_500"]`:
- `wrong_total`: cart total adds $1.00.
- `search_ignores_query`: results list every product, heading still "Results for …".
- `login_no_error`: a refused login shows the form again with no error message (status 200).
- `add_to_cart_noop`: "Added to cart" flash, cart unchanged.
- `price_mismatch`: product page price is $10.00 higher than the list's.
- `product_500`: `/products/:id` answers 500 with `<h1>500 Internal Server Error</h1>`.
- Wishlist: product page "Add to wishlist" button; a guest gets a sign-in dialog (`role="dialog"`, email + password fields) rendered by script; signed in, the product is added and `/wishlist` lists it.

- [ ] Steps 1–4: a test per bug flag and for the wishlist guest dialog; fail; implement; pass (`pnpm --filter @platform/demo-shop test`).

### Task 12: Benchmark runner and corpus

**Files:**
- Create: `evals/benchmark/corpus.json`, `evals/benchmark/metrics.ts`, `evals/benchmark/metrics.test.ts`, `evals/benchmark/run.ts`, `evals/benchmark/README.md`
- Create: `scripts/quality-benchmark.sh`
- Modify: `vitest.config.ts` (project `evals`: `evals/**/*.test.ts`), `package.json` (`"benchmark": "tsx evals/benchmark/run.ts"`, `"test:evals": "vitest run --project evals"`)

**Interfaces — Produces:**
- Case: `{ id: string; site: string; targetUrl: string; requirement: string; expect: "PASSED" | "FAILED" | "ANY"; bug?: string }`.
- `summarize(results: CaseRun[]): BenchmarkSummary` with `runs`, `errored`, `verdicts`, `criteria: { total, pass, fail, blocked, inconclusive }`, `decidedRate`, `bugsCaught` / `bugCases`, `falsePasses` (bug case PASSED), `falseFails` (healthy case FAILED), `shallowPasses`, `rerunConfirmedRate`, `inconclusiveReasons`, `costUsd`, `medianDurationS`, `perCase` with each repeat's verdict and `stable`.
- `renderMarkdown(summary, previous?: BenchmarkSummary): string` — the tables, with a delta column when `previous` is given.
- `run.ts`: `pnpm benchmark [--sites a,b] [--repeat n] [--concurrency n] [--compare file]`; submits through the API (`API_URL`, `API_TOKEN` as `tests/shopware/platform.mjs`), retries a 429 after 20 s, polls until terminal, writes `.artifacts/benchmark/<timestamp>/results.json` and `summary.md`.
- Corpus: the 12 frontends-demo cases (`expect: "ANY"`, FD-11 `ANY`), demo shop healthy cases (`PASSED`) and one per seeded bug (`FAILED`), the frontends-demo nonexistent-search defect (`FAILED`), demowebshop.tricentis.com search and add-to-cart (`PASSED`).

- [ ] Step 1: `metrics.test.ts`: a bug case FAILED counts as caught; PASSED as a false pass; a healthy FAILED as a false fail; decided rate 3/4 for PASS, FAIL, INCONCLUSIVE, PASS; `stable` false when repeats differ; markdown has a delta column with `previous`.
- [ ] Step 2–4: fail, implement, pass (`pnpm test:evals`).

### Task 13: Documentation

- Modify: `docs/known-issues.md` (KI-073, KI-074 resolved with what was checked; KI-077 username remainder resolved; new KIs for what live runs show), `README.md` (a dated "Exploration and testing quality (2026-11-19)" bullet), `evals/BASELINE.md` (KI-076 rows; benchmark section), `evals/benchmark/README.md`.

### Task 14: Verification

- [ ] `pnpm typecheck` → no errors.
- [ ] `pnpm test` and `pnpm test:evals` → pass.
- [ ] `pnpm test:integration` and `pnpm test:e2e` → pass.
- [ ] Rebuild the compose stack (`pnpm stack:up`) and run `pnpm eval requirement-compiler` and `pnpm eval planner` on deepseek-flash (KI-076); record rows.
- [ ] Run the benchmark once on the stack with deepseek-flash; record the baseline in `evals/BASELINE.md`.
