# Quality benchmark

End-to-end runs of real requirements against real sites, through the platform's public API, scored on what matters to a
person reading the report (2026-11-19). The model evals (`pnpm eval <suite>`) score one prompt each; this scores the whole
run: analysis, planning, exploration, verification and the Playwright rerun.

## What it measures

| Metric | Why |
|---|---|
| Criteria decided (PASS + FAIL) | The share of checks the platform actually answers. |
| Bugs caught / false passes | Cases run against a seeded defect (`DB-*`) must FAIL. A PASS there is the worst error a testing platform can make. |
| False fails | Cases on a working site that FAILED: a platform error reported as a site defect. |
| Expected verdict | Every case with a known answer (`expect` other than `ANY`). |
| Passes on one broad check | A vague or site-wide requirement that passed on a single check ("the website loads"). |
| Decided criteria the rerun confirmed | How much of the evidence the generated Playwright test reproduced. |
| Model cost, median run time | What a run costs. |
| Unstable cases | Cases whose verdict differs between repeats (each run compiles its own criteria and plan). |

## Corpus

`corpus.json`: the demo shop (healthy cases, one case per seeded defect, a server error page), the 12 unclear
requirements of `evals/e2e-unclear` on frontends-demo.vercel.app, its known search defect, and two cases on
demowebshop.tricentis.com. The demo shop's defects are its `?bug=` flags (`tests/fixtures/demo-shop/src/server.js`,
`KNOWN_BUGS`).

## Running it

Against the compose stack (`pnpm stack:up`, with a real `LLM_PROVIDER` and key):

```bash
pnpm benchmark                                  # every case once, two at a time
pnpm benchmark --sites demo-shop --repeat 3     # one site, three repeats
pnpm benchmark --cases DB-02,DB-03 --model deepseek-v4-pro --reasoning minimal
pnpm benchmark --compare .artifacts/benchmark/<earlier>/results.json
./scripts/quality-benchmark.sh                  # rebuild the stack, run, compare with the last results
```

Results go to `.artifacts/benchmark/<timestamp>/` (`results.json` with every report, `summary.md`). Record the headline
table in `evals/BASELINE.md` (section "Quality benchmark") with the date, model and commit. The metrics are unit-tested:
`pnpm test:evals`.
