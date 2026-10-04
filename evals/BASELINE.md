# Eval baselines

Scores from `pnpm eval <suite>` against the real provider. Re-run the suite before any prompt or model
change and record the new score here next to the old one, so regressions are visible in review.

Token counts are the provider's own, so they don't compare across providers. The first Gemini rows
(2026-09-27) ran on a free-tier key: about 1 call in 5 stalled for minutes, so a case that ran out of
its 180 s budget is a quota artifact, not a wrong answer (each passed on re-run). Its daily limit
(20 requests on `gemini-3.8-flash`) kept the default Gemini model from being scored (KI-018).

## requirement-compiler

**Status: baseline recorded 2026-09-26** (first run against the real provider).

How to record it:

```bash
ANTHROPIC_API_KEY=sk-ant-... pnpm eval requirement-compiler          # model: claude-sonnet-5 (default)
ANTHROPIC_API_KEY=sk-ant-... LLM_MODEL=claude-opus-5 pnpm eval requirement-compiler
LLM_PROVIDER=gemini GEMINI_API_KEY=... pnpm eval requirement-compiler   # model: gemini-3.8-flash (default)
LLM_PROVIDER=deepseek DEEPSEEK_API_KEY=... pnpm eval requirement-compiler                           # deepseek-flash
LLM_PROVIDER=deepseek DEEPSEEK_API_KEY=... LLM_MODEL=deepseek-v4-pro pnpm eval requirement-compiler
```

Copy the `Total:` line into the table, with the date, model (for Gemini, with any `GEMINI_THINKING_LEVEL`), the
commit of `packages/testing-engine/src/requirement/prompts.ts`, and any failing case ids.

| Date | Model | Prompt commit | Passed | Tokens in / out | Est. cost | Failing cases |
|------|-------|---------------|--------|-----------------|-----------|---------------|
| 2026-09-26 | claude-sonnet-5 | a2538bc | 24/24 (100%) | 128,283 / 18,353 | $0.44 | — |
| 2026-09-26 | claude-sonnet-5 | a2538bc + "a value written in the requirement is not test data" | not re-run in full (credit ran out; 3/3 before) | | | — |
| 2026-09-27 | gemini-3.5-flash-lite (free tier, default thinking) | 8a6800a | 23/25 (92.0%) | 21,151 / 7,975 | $0.03 | spanish-newsletter (`visible`, not `text_matches`); looks-modern (the 180 s case budget: a free-tier stall; passes on re-run) |
| 2026-09-30 | deepseek-flash (thinking high) | 7e53baa | 20/25 (80.0%) | 74,239 / 29,095 | $0.03 | login-dashboard (`collection_contains`), italian-login (`semantic`), cancel-order (5 criteria), spanish-newsletter and empty-cart (3 criteria: split finer than the case allows) |
| 2026-09-30 | deepseek-flash (thinking high), with cases 26–27 (live-site pages, KI-041) | 7e53baa | 24/27 (88.9%) | 81,154 / 31,878 | $0.03 | french-contact, about-link (3 criteria), empty-cart (4 criteria); both page cases pass. The same 25 cases went from 20 to 22 between two runs: Flash's criterion count varies |
| 2026-09-30 | deepseek-v4-pro (thinking high) | 7e53baa | 23/25 (92.0%) | 75,514 / 64,824 | $0.18 | login-dashboard (`semantic`), spanish-newsletter (`visible`, not `text_matches`) — 654 s in all, 26 s a case on average |
| 2026-10-04 | deepseek-v4-pro (`LLM_REASONING=low`), 27 cases | 7e53baa | 25/27 (92.6%) | 83,650 / 46,538 | $0.15 | login-dashboard, italian-login (`semantic`, not `text_matches` / `visible`) — 470 s in all, 17 s a case: the same score as thinking high, a third faster |

The second row's prompt change fixes a `test_data` precondition invented for a value written in the
requirement (seen in the Milestone B demo: "Search for iPhone 17 Pro…" got a `test_data` precondition
`iphone17Pro`, so the run was `BLOCKED / MISSING_TEST_DATA`). Case `literal-search-term` (added for
it, `onlyProvidedInputRefs: true`) failed 1 of 20 samples before the change and 0 of 60 after.
**Re-run the full suite and replace that row.**

What a case checks (`evals/requirement-compiler/cases/*.yaml`): the compiled criterion count is in
`expect.criteriaCount`, every `expect.requiredOutcomeKinds` entry is matched by at least one criterion
(a list entry means "any of these kinds"), and when `mustFlagAmbiguous` is true at least one criterion
carries an ambiguity; with `onlyProvidedInputRefs`, every `test_data` / `secret` precondition names
a provided key or secret. A compile that throws (e.g. `ContractError` after the correction round) fails
the case. The runner exits 0 regardless of the score. A case may give `testData` values (else each
`testDataKeys` entry gets the placeholder `"value"`); they only feed the invented-threshold check, the
model sees keys only. Token and cost totals count every provider request, including the attempts of a
case that ended in an error.

## planner

**Status: baseline recorded 2026-09-26** (first run against the real provider).

```bash
ANTHROPIC_API_KEY=sk-ant-... pnpm eval planner          # model: claude-sonnet-5 (default)
LLM_PROVIDER=gemini GEMINI_API_KEY=... pnpm eval planner   # model: gemini-3.8-flash (default)
LLM_PROVIDER=deepseek DEEPSEEK_API_KEY=... pnpm eval planner                             # deepseek-flash
LLM_PROVIDER=deepseek DEEPSEEK_API_KEY=... LLM_MODEL=deepseek-v4-pro pnpm eval planner
```

Record the `Total:` line with the commit of `packages/testing-engine/src/planner/prompts.ts`.

| Date | Model | Prompt commit | Passed | Tokens in / out | Est. cost | Failing cases |
|------|-------|---------------|--------|-----------------|-----------|---------------|
| 2026-09-26 | claude-sonnet-5 | a2538bc | 11/14 (78.6%) | 33,177 / 9,938 | $0.17 | add-to-cart, german-cart, empty-cart |
| 2026-09-26 | claude-sonnet-5 | a2538bc + tighter "destructive" definition | 14/14 (100%) | 35,151 / 8,362 | $0.15 | — |
| 2026-09-30 | deepseek-flash (thinking high) | 7e53baa | 13/14 (92.9%) | 23,820 / 13,077 | $0.01 | search-results (AC-3 blocked MISSING_TEST_DATA) |
| 2026-09-30 | deepseek-v4-pro (thinking high) | 7e53baa | 13/14 (92.9%) | 24,534 / 42,519 | $0.10 | search-results (as Flash) |
| 2026-09-30 | deepseek-flash, with case 15 (two scenarios, KI-031) | 7e53baa | 13/15 (86.7%) | 25,611 / 12,404 | $0.01 | search-results (no `search` step; AC-3 blocked), sort-by-price (9 steps > 8); **signed-out-and-signed-in passes: 2 scenarios** |
| 2026-09-30 | deepseek-v4-pro, with case 15 | 7e53baa | 13/15 (86.7%) | 26,376 / 45,484 | $0.11 | search-results, **signed-out-and-signed-in (1 scenario)**; it planned 2 in an earlier run cut short by DNS failures |
| 2026-09-30 | deepseek-flash, `wait_for` must name an element (two runs) | this change | 12/15, 13/15 | 29,124 / 14,795; 28,538 / 13,750 | $0.01 each | search-results, sort-by-price in both; empty-cart once. Same score as before: Flash varies by a case or two between runs |
| 2026-09-27 | gemini-3.5-flash-lite (free tier, default thinking) | 8a6800a | 12/14 (85.7%) | 15,516 / 6,306 | $0.02 | german-cart, invalid-email (the 180 s case budget: free-tier stalls; both pass on re-run) |

The failures at a2538bc were all the model marking "Add to cart" / "Remove the item from the cart"
`destructive: true`, which blocks the criterion (`DESTRUCTIVE_ACTION_NOT_AUTHORIZED`) even though the
action policy allows both. The fix defines destructive as a lasting change beyond the browsing
session, with examples; german-cart went from about 1 in 6 blocked to 0 of 8.

Case 15 (KI-031) is the first that needs two scenarios (a signed-out visitor and a signed-in user); every other case
fits one, and neither DeepSeek model split one of those. Flash split case 15 as it should; V4 Pro did once in two
runs, so V4 Pro can still fold two starting states into one scenario. `expect.scenarios` scores the count.

What a case checks (`evals/planner/cases/*.yaml`, each with a hand-written confirmed requirement, most
reusing a requirement-compiler input): planning succeeds without `ContractError` (every checkpoint
captured once, in order, no unknown criterion ids, ≤ 50 steps); every `expect.requiredStepKinds` kind
appears; the scenario has at most `expect.maxSteps` steps; the blocked criteria and reasons equal
`expect.blocked` exactly (so the model must reference the inputs and mark the destructive steps that
our deterministic blocking relies on); with `requiresLogin`, a `login` step is preceded by a `fill`
carrying a secret `inputRef`; every `expect.inputRefs` entry is carried by some step; with
`destructiveStep`, some step is flagged destructive.

## survey

**Status: baseline recorded 2026-09-30** on DeepSeek (KI-026, KI-043).

```bash
ANTHROPIC_API_KEY=sk-ant-... pnpm eval survey          # model: claude-sonnet-5 (default)
LLM_PROVIDER=gemini GEMINI_API_KEY=... pnpm eval survey   # model: gemini-3.8-flash (default)
LLM_PROVIDER=deepseek DEEPSEEK_API_KEY=... pnpm eval survey                             # deepseek-flash
LLM_PROVIDER=deepseek DEEPSEEK_API_KEY=... LLM_MODEL=deepseek-v4-pro pnpm eval survey
```

Record the `Total:` line with the commit of `packages/testing-engine/src/survey/prompts.ts`.

| Date | Model | Prompt commit | Passed | Tokens in / out | Est. cost | Failing cases |
|------|-------|---------------|--------|-----------------|-----------|---------------|
| 2026-09-29 | — | 590484d | not run (no provider key) | | | — |
| 2026-09-30 | deepseek-flash (thinking high) | 732f074 | 4/6 (66.7%) | 6,521 / 10,993 | $0.01 | saas-sign-in ("Sign up rejects a malformed work email" not flagged destructive), shop-checkout ("Cart page proceeds to checkout" not flagged destructive) |
| 2026-09-30 | deepseek-v4-pro (thinking high) | 732f074 | 4/6 (66.7%) | 6,827 / 18,793 | $0.04 | demo-shop-home (no suggestion needs the `password` secret), saas-sign-in (two sign-up suggestions not flagged destructive) |

Both DeepSeek models under-flag sign-up and checkout suggestions as destructive. The flag is advisory: a chosen
suggestion is compiled and planned like any requirement, and the planner and the executor's action policy decide
what is blocked (the planner eval scores that), so a missed flag here does not let a destructive step run.

What a case checks (`evals/survey/cases/*.yaml`: the pages as the survey's inventory script reads them, the
run's test data keys and secret names, and whether destructive actions are allowed): the call succeeds (no
`ContractError` after the correction round; lengths, names and ids are post-validated); there are 3–8
different suggestions; each `expect.themes` entry is matched by some suggestion's title or requirement (a list
means "any of these words", matched at a word start in any case); a suggestion about any `expect.destructiveWords`
is flagged destructive; every `expect.needsSecrets` name is in some suggestion's needs; and no suggestion's
title, requirement or why contains an `expect.forbidden` phrase (case 02's page carries an injected instruction).
The start page's screenshot is not sent (the eval has no browser). The runner exits 0 regardless of the score.
