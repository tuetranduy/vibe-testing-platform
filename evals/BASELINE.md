# Eval baselines

Scores from `pnpm eval <suite>` against the real provider. Re-run the suite before any prompt or model
change and record the new score here next to the old one, so regressions are visible in review.

## requirement-compiler

**Status: pending — no baseline recorded yet.** The environment this harness was built in has no
`ANTHROPIC_API_KEY`, so the suite has not been run against a real model. No score below is real
until someone records it.

How to record it:

```bash
ANTHROPIC_API_KEY=sk-ant-... pnpm eval requirement-compiler          # model: claude-sonnet-5 (default)
ANTHROPIC_API_KEY=sk-ant-... LLM_MODEL=claude-opus-5 pnpm eval requirement-compiler
```

Copy the `Total:` line into the table, with the date, model, the commit of
`packages/testing-engine/src/requirement/prompts.ts`, and any failing case ids.

| Date | Model | Prompt commit | Passed | Tokens in / out | Est. cost | Failing cases |
|------|-------|---------------|--------|-----------------|-----------|---------------|
| _pending_ | | | | | | |

What a case checks (`evals/requirement-compiler/cases/*.yaml`): the compiled criterion count is in
`expect.criteriaCount`, every `expect.requiredOutcomeKinds` entry is matched by at least one criterion
(a list entry means "any of these kinds"), and when `mustFlagAmbiguous` is true at least one criterion
carries an ambiguity. A compile that throws (e.g. `ContractError` after the correction round) fails
the case. The runner exits 0 regardless of the score.

## planner

**Status: pending — no baseline recorded yet.** Same reason as above (no `ANTHROPIC_API_KEY` where
the suite was built, Ruling R8). No score below is real until someone records it.

```bash
ANTHROPIC_API_KEY=sk-ant-... pnpm eval planner          # model: claude-sonnet-5 (default)
```

Record the `Total:` line with the commit of `packages/testing-engine/src/planner/prompts.ts`.

| Date | Model | Prompt commit | Passed | Tokens in / out | Est. cost | Failing cases |
|------|-------|---------------|--------|-----------------|-----------|---------------|
| _pending_ | | | | | | |

What a case checks (`evals/planner/cases/*.yaml`, each with a hand-written confirmed requirement, most
reusing a requirement-compiler input): planning succeeds without `ContractError` (every checkpoint
captured once, in order, no unknown criterion ids, ≤ 50 steps); every `expect.requiredStepKinds` kind
appears; the scenario has at most `expect.maxSteps` steps; the blocked criteria and reasons equal
`expect.blocked` exactly (so the model must reference the inputs and mark the destructive steps that
our deterministic blocking relies on); with `requiresLogin`, a `login` step is preceded by a `fill`
carrying a secret `inputRef`; every `expect.inputRefs` entry is carried by some step; with
`destructiveStep`, some step is flagged destructive.
