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
