# Improvement plan: test well even when the requirement is unclear

**Date:** 2026-11-06 · **Scope:** ANALYZING_REQUIREMENT, PLANNING, EXPLORING (`packages/testing-engine/src/{requirement,planner,exploration,survey}`)

**Goal:** when a user writes a vague requirement ("test the checkout", "make sure login works", "check search"), the
platform still reads the site on its own, works out what to test, tests it, and says what it assumed. Today it
usually ends INCONCLUSIVE, stops early, or errors.

---

## 1. Why it fails today

The pipeline is **understand once → plan once → execute the plan exactly**. Each stage gets one shot, and a
failure at any point ends the run or leaves the criteria INCONCLUSIVE.

| # | Where | What happens with an unclear requirement | Code |
|---|---|---|---|
| A1 | Site read | Links are ranked by overlap with the requirement's words. A vague requirement shares few words, so the 3 pages it reads are close to arbitrary. The interactive pass has a fixed 6 actions. | `requirement/compiler.ts` `linkRelevance`, `ANALYSIS_SITE_LINKS = 3`; `survey/site-reader.ts` `budget: { remaining: 6 }` |
| A2 | Criteria | Every criterion needs a `sourceText` copied verbatim from the requirement, so the model cannot add the checks a vague requirement implies (e.g. "login works" → wrong password shows an error). | `requirement/prompts.ts`, `requirement/post-validate.ts` |
| A3 | Criteria | Vague wording becomes a `semantic` outcome with an `ambiguity`. Even with `autoConfirmCriteria` it stays that way and ends `INCONCLUSIVE / AMBIGUOUS_CRITERION`. The model's own `suggestions` (rewrites) are never used. | `verification/verifier.ts:110` |
| A4 | Criteria | One correction round, then `ContractError`: the run **errors** instead of keeping the criteria that were valid. | `compileRequirement` → `generateStructured` |
| A5 | Routing | Only a *blank* requirement goes to the survey. "Test this website" is compiled like a precise spec. A survey run always waits for the user to pick (no autonomous mode). | `orchestrator.ts` `runSurvey` |
| P1 | Plan | The whole plan is fixed before exploration and built from what pages showed **on load**. Controls that only appear after an action (modals, drawers, multi-step forms) are guessed. | `planner/prompts.ts` |
| P2 | Plan | Strict checks (each checkpoint exactly once, order, ≤1 login per scenario) fail fast: one correction round, then `ContractError` → run errors. Most of these could be repaired by code. | `planner/post-validate.ts` |
| P3 | Plan | Steps must be concrete UI actions. There is no way to say "get to the checkout" and let the executor find the route. | `PlannedStepSchema.kind` |
| E1 | Explore | One retry per step; then the scenario stops (`Stop("COMPLETED")`), and every later checkpoint is INCONCLUSIVE. | `executor.ts` `withRetry`, `MAX_ATTEMPTS = 2` |
| E2 | Explore | Recovery is a single hop ("find the link or button that leads to…"), from one `observe`. No look at the page as a whole, no second hop, no backtracking. | `executor.ts` `act` (KI-048, KI-050) |
| E3 | Explore | No replanning: what exploration learns (the real page) never goes back to the plan. | — |
| E4 | Explore | Single-page-app gaps still open (e.g. KI-065: a modal login reported LOGIN_FAILED). | `verification/verifier.ts` rule 3 |

---

## 2. Target design

Move from "execute a fixed plan" to **goal-directed testing with bounded autonomy**. The safety rules stay
deterministic and unchanged: the action policy, destructive-action blocking, host allowlist and redaction.

```
requirement ──► Clarity triage ──► Goal-directed site discovery ──► Intent expansion (stated + inferred criteria)
                                                                          │
                                         ┌────────────────────────────────┘
                                         ▼
                      Plan with goal steps + deterministic repair
                                         │
                                         ▼
                Adaptive executor: act → (fail) → multi-hop find → replan the rest (bounded)
                                         │
                                         ▼
                      Report: results + "Assumptions the platform made"
```

### Principles
1. **Never error on vagueness.** A vague requirement gives you assumptions, not a failed run. `ContractError` is only for
   output that is truly broken *after* deterministic repair.
2. **Stated vs. inferred.** Every criterion is tagged `origin: "stated" | "inferred"`. Inferred ones have a rationale,
   show separately in the review and the report, and can be turned off.
3. **Bounded autonomy.** Every new loop (discovery, multi-hop, replan) has a hard cap on actions, model calls and time,
   taken from the existing exploration budget.
4. **The site is the source of truth.** What is found on the site decides *how* to test, and *what* to test when the
   requirement doesn't say. It never weakens a stated criterion (the rule the current prompts already follow).

---

## 3. Workstreams

### WS0: Measure first (prerequisite, ~2 days)
- Build an **unclear-requirement corpus** in `evals/`: about 20 requirements across demoqa, frontends-demo, the demo
  shop. Mix one-word ("login"), feature-level ("test the cart"), vague ("check the site works"), mis-named ("sign up
  page" when the site says "New User") and typo'd ones.
- Add a `pnpm eval e2e-unclear` harness that runs analyze → plan → explore with `autoConfirmCriteria: true` and records:
  run **errored** %, criteria **INCONCLUSIVE** %, **first-failed-step** index, number of criteria, model calls, wall time.
- Record a baseline in `evals/BASELINE.md`. Every workstream below must move these numbers.

### WS1: Requirement analysis

**1.1 Clarity triage** (new, cheap model call or part of the compile call)
- Classify the requirement as `specific | feature | vague | site_wide`.
- `site_wide` ("test this website") → survey path in **autonomous mode** (1.5).
- `feature`/`vague` → larger discovery budget (1.2) and intent expansion (1.3).

**1.2 Goal-directed site discovery** (`compiler.ts` `readLiveSite`, `survey/site-reader.ts`, `survey/interactive.ts`)
- Link ranking: blend the word overlap with **synonyms the model gives in the triage call** (login ↔ sign in ↔ account ↔
  "New User"). Fall back to the navigation area (header/nav links) when nothing scores, instead of an arbitrary order.
- Size the budget to the clarity: `specific` stays as today (3 links, 6 actions); `feature`/`vague` → up to 6 links and 12
  actions. Still capped by `ANALYSIS_SITE_BUDGET_MS`.
- Give the interactive pass the **feature target** from triage. Its prompt today says "prefer actions relevant to the
  requirement", but that has nothing to work with when the requirement is vague.
- Open dialogs, drawers and menus that hold the feature (cart drawer, login modal) and record the inventory *after* the
  action. That is the data the planner is missing (P1).

**1.3 Intent expansion: stated + inferred criteria** (`contracts`, `requirement/prompts.ts`, `post-validate.ts`)
- Contract: add `origin: "stated" | "inferred"` and `rationale` to `AcceptanceCriterion`. `sourceText` stays required and
  verbatim for `stated` criteria. For `inferred` ones it is the requirement phrase they expand (it may be the whole text).
- Prompt: for `feature`/`vague` requirements, add a short, standard set of checks *grounded in the pages read*:
  the happy path, one visible negative path when it is safe (wrong password → error; empty search → message), and the
  visible result (a cart line, a URL, a heading). Cap: at most 5 inferred criteria, never destructive unless the run
  allows it.
- Inferred criteria must name the control or page they rely on from the site read (`siteChecks: found`). Otherwise they
  are dropped deterministically, so nothing is invented that the site doesn't show.

**1.4 Resolve ambiguity instead of parking it** (`post-validate.ts`, verifier)
- When a criterion has `ambiguity.suggestions` and the run auto-confirms (or the user doesn't edit it), **adopt the
  first suggestion that compiles to a structured outcome** and mark it `assumed: true` with the original wording.
- Keep `semantic` only for real look-and-feel checks, which the existing judge (`exploration/judge.ts`) handles.
- In the review UI, show the assumption beside the criterion, so the user can accept or rewrite it in one click.

**1.5 Autonomous survey mode** (`orchestrator.ts` `runSurvey`)
- With `autoConfirmCriteria` (or a new `autonomy: "full"` option), a `site_wide` or blank requirement doesn't stop at
  AWAITING_SELECTION. It takes the top N non-destructive suggestions (default 3) and runs them as criteria of one run,
  or as child runs of a suite (the suites feature already exists).

**1.6 Degrade, don't error** (`compileRequirement`)
- After the correction round, **keep the valid criteria and drop the invalid ones**. Report each dropped one as an
  assumption note.
- With zero valid criteria, fall back to one `semantic` criterion built from the whole requirement ("the described
  flow can be completed"), judged after exploration. The run continues.

### WS2: Planning

**2.1 Goal steps** (`contracts` `PlannedStepSchema`, `planner/prompts.ts`)
- Add a step kind `reach`: "reach the page/state where X is visible" (e.g. "reach the checkout page", "open the login
  form"), with a `successHint` (the URL pattern or element that shows you're there).
- The prompt rule: use `reach` whenever the pages read do not show the route. Keep concrete `click`/`fill` steps where
  they do. This replaces guessing (KI-048's root cause) with an explicit "find it at run time".

**2.2 Deterministic plan repair before the correction round** (`planner/post-validate.ts`)
- Fix mechanically before asking the model again:
  - a missing `capture_checkpoint` → append it at the end of the owning scenario (or after the last step naming the criterion);
  - a duplicate capture → keep the last one;
  - `before_*`/`after_*` out of order → swap when no action sits between them, else move the `before` capture before the first action;
  - two logins in one scenario → split into a new scenario at the second login;
  - a `fill` with no `inputRef` → attach a generated `testData` key named after the field.
- Ask the model only for what code can't fix. After that, keep the valid scenarios and block only the criteria of the
  invalid ones (`blockedCriteria` with a new reason `PLAN_INVALID`). Never error the whole run.

**2.3 Plan from post-action inventories**
- Hand the planner the inventories recorded *after* interactions (1.2). The `SitePage.interactions` field already
  carries them. Tighten the prompt to prefer the paths actually observed over guessed ones.

### WS3: Exploration (the biggest win)

**3.1 Execute `reach` steps with a small agent loop** (`exploration/executor.ts`, a new `exploration/navigator.ts`)
- Loop: read the page inventory (reuse `survey/inventory.ts`) → model picks one candidate toward the goal → policy check
  (`assertActionAllowed`, host allowlist) → act → settle → check `successHint`.
- Caps: at most 6 actions per `reach`, no repeated action, backtrack (`page.goBack()`) once on a dead end. Every action is
  recorded as a normal step (off the golden path), so the evidence and the generated Playwright test still work. Only
  the successful path is compiled.

**3.2 Multi-hop recovery for concrete steps** (replaces the single-hop "way there")
- When a `click`/`fill` target isn't found after the retry, run the 3.1 navigator with the step's target as the goal
  (at most 3 hops), then try the step again. This covers KI-048/KI-050-type failures in general instead of case by case.

**3.3 Bounded replanning** (a new `exploration/replanner.ts`)
- When a step still fails after 3.2, send the planner the **current page inventory**, the steps done so far, the
  remaining steps, and the criteria not yet captured. Ask for a new *remainder* of the scenario, checked by the same
  `validatePlanOutput` and `applyBlocking` (so policy stays deterministic).
- Cap: 2 replans per scenario, each counted against the exploration budget. A replan event (`plan.revised`) is published
  and shown in the run view.

**3.4 Don't throw away the other criteria**
- A failed step today ends its scenario. Change it so criteria whose checkpoints **don't depend on** the failed step
  (`dependencyEnd` in `planner/blocking.ts` already computes this) keep going: skip ahead to the next independent capture.
- Capture opportunistically: if a checkpoint's facts are visible on the current page before its planned step (e.g. the
  cart count is already on screen), read them there as well. That gives a fallback value if the scenario later stops.

**3.5 Close the open SPA gaps**
- KI-065 (modal login): record whether the login fields are still shown after the `login` click. Rule 3 then needs both
  an unchanged URL *and* the form still present.
- Add the unclear-requirement corpus sites to `tests/integration` with recorded fixtures.

**3.6 Learn routes across runs** (extends the exploration cache, V1.1 F8)
- Cache the successful `reach` paths by (origin, goal). A later run's `reach` tries the cached path first. It is checked
  like today's cache (KI-032 rules), and the 10% recheck rate applies.

### WS4: Transparency (needed for trust when the platform decides on its own)
- Report and run view: an **"Assumptions" section** listing the inferred criteria (with rationale), the resolved
  ambiguities (original → adopted), `reach` routes found, and replans (why, what changed).
- Verdict wording: a PASS that rests only on inferred criteria reads as "Passed (on assumed criteria)".
- Suite promotion: the user can save the run's final criteria and plan as a precise test, which turns the assumptions
  into stated criteria.

---

## 4. Safety

- The new loops (navigator, replanner, inferred criteria) **can only propose** actions. `assertActionAllowed`, the
  destructive flag and `applyBlocking`, the host allowlist and redaction run on every one of them, unchanged.
- Inferred criteria are never destructive unless `allowDestructiveActions` is on, and they are never about credentials.
- The navigator's candidate filter reuses `survey/interactive.ts` `canExplore` (no sign-out, no account creation unless
  planned, no submit except search/login).
- All page content stays untrusted data in every new prompt (the same markers and rules as today).

---

## 5. Order of work and success criteria

| Phase | Work | Why first | Exit criterion (on the WS0 corpus, DeepSeek Flash) |
|---|---|---|---|
| 1 | WS0 baseline; 1.6 degrade-don't-error; 2.2 deterministic repair | Cheap, no contract change, removes **errored** runs | Errored runs → 0% |
| 2 | 3.2 multi-hop recovery; 3.4 keep independent criteria; 3.5 KI-065 | Biggest INCONCLUSIVE reducer, executor-only | First-step failures ↓ 50%; INCONCLUSIVE ↓ 30% |
| 3 | 1.1 triage; 1.2 goal-directed discovery; 2.3 post-action inventories | Better input to the planner | Planned control is on the right page ≥ 90% |
| 4 | 1.3 inferred criteria; 1.4 ambiguity resolution; WS4 assumptions UI | Needs the contract change and UI | Vague requirements yield ≥ 3 checkable criteria; AMBIGUOUS_CRITERION ↓ 80% |
| 5 | 2.1 `reach` steps + 3.1 navigator; 3.3 replanning | Largest change; builds on 3.2 | Corpus PASS/FAIL (decided) rate ≥ 75% |
| 6 | 1.5 autonomous survey; 3.6 route learning | Comfort and cost | Second run on the same site: ≥ 30% fewer model calls |

For each phase: re-run `pnpm eval requirement-compiler`, `planner`, `judge`, `survey` (prompts change), plus the new
corpus. Record in `evals/BASELINE.md`, and add or close a KI entry in `docs/known-issues.md` as today.

## 6. Risks
- **Inferred criteria that are wrong or noisy** → cap of 5, must be grounded in `siteChecks: found`, shown as assumptions, off by default for `specific` requirements.
- **Cost and time of the agent loops** → hard caps per loop, everything counted against `budgets.explorationMs`; measured in WS0.
- **Generated Playwright tests from adaptive runs** → compile only the golden path; `reach` compiles to the concrete clicks that worked.
- **Prompt regressions** → every prompt change goes through its eval suite before merge (as the prompt headers already require).
