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
```

Copy the `Total:` line into the table, with the date, model (for Gemini, with any `GEMINI_THINKING_LEVEL`), the
commit of `packages/testing-engine/src/requirement/prompts.ts`, and any failing case ids.

| Date | Model | Prompt commit | Passed | Tokens in / out | Est. cost | Failing cases |
|------|-------|---------------|--------|-----------------|-----------|---------------|
| 2026-09-26 | claude-sonnet-5 | a2538bc | 24/24 (100%) | 128,283 / 18,353 | $0.44 | — |
| 2026-09-26 | claude-sonnet-5 | a2538bc + "a value written in the requirement is not test data" | not re-run in full (credit ran out; 3/3 before) | | | — |
| 2026-09-27 | gemini-3.5-flash-lite (free tier, default thinking) | 8a6800a | 23/25 (92.0%) | 21,151 / 7,975 | $0.03 | spanish-newsletter (`visible`, not `text_matches`); looks-modern (the 180 s case budget: a free-tier stall; passes on re-run) |

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
```

Record the `Total:` line with the commit of `packages/testing-engine/src/planner/prompts.ts`.

| Date | Model | Prompt commit | Passed | Tokens in / out | Est. cost | Failing cases |
|------|-------|---------------|--------|-----------------|-----------|---------------|
| 2026-09-26 | claude-sonnet-5 | a2538bc | 11/14 (78.6%) | 33,177 / 9,938 | $0.17 | add-to-cart, german-cart, empty-cart |
| 2026-09-26 | claude-sonnet-5 | a2538bc + tighter "destructive" definition | 14/14 (100%) | 35,151 / 8,362 | $0.15 | — |
| 2026-09-27 | gemini-3.5-flash-lite (free tier, default thinking) | 8a6800a | 12/14 (85.7%) | 15,516 / 6,306 | $0.02 | german-cart, invalid-email (the 180 s case budget: free-tier stalls; both pass on re-run) |

The failures at a2538bc were all the model marking "Add to cart" / "Remove the item from the cart"
`destructive: true`, which blocks the criterion (`DESTRUCTIVE_ACTION_NOT_AUTHORIZED`) even though the
action policy allows both. The fix defines destructive as a lasting change beyond the browsing
session, with examples; german-cart went from about 1 in 6 blocked to 0 of 8.

What a case checks (`evals/planner/cases/*.yaml`, each with a hand-written confirmed requirement, most
reusing a requirement-compiler input): planning succeeds without `ContractError` (every checkpoint
captured once, in order, no unknown criterion ids, ≤ 50 steps); every `expect.requiredStepKinds` kind
appears; the scenario has at most `expect.maxSteps` steps; the blocked criteria and reasons equal
`expect.blocked` exactly (so the model must reference the inputs and mark the destructive steps that
our deterministic blocking relies on); with `requiresLogin`, a `login` step is preceded by a `fill`
carrying a secret `inputRef`; every `expect.inputRefs` entry is carried by some step; with
`destructiveStep`, some step is flagged destructive.
