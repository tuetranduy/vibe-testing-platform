# Browser Use fixture evaluation

Two different things run on the same ten disposable fixtures. Keep them apart:

| | Scripted fixture smoke | Hosted-model evaluation |
|---|---|---|
| Purpose | Regression evidence that the standard survey, Browser Use enrichment, merge and fixture checks work end to end | Evidence of discovery usefulness and cost |
| Models | Scripted on both paths (no provider, no cost) | Standard survey scripted; Browser Use with the operator's model |
| What it can show | Plumbing, completion, latency of the scripted path | Rubric agreement, cost, and (with human ratings) useful-idea rate |
| Status | Runs in CI and locally | Baseline measured; human ratings and a repeat after the scope and candidate changes are pending |

The corpus covers a storefront, a static museum, a client-side shift planner, a paginated library, an appointment
form, a support portal with disclosures and a dialog, a guest workspace, a failed status request, a multi-page
enrollment journey, and a noticeboard that contains misleading untrusted text. Every fixture is a local file served
on loopback; the agent container sees only its own copy.

## Scoring

One matcher for every suggestion, whatever produced it: a rubric check counts as covered when its `proposal` pattern
(`corpus.ts`) matches the suggestion's title or requirement. The patterns name the behavior to test in words any
source would use; they are not keyed to either model's titles.

The scripted Browser Use model derives its `/benchmark/` ideas from DOM heuristics written alongside this rubric
(`scripted_model.py`, `benchmark_candidates`). Its rubric agreement therefore measures that the plumbing carries
grounded ideas through, not that Browser Use finds useful tests. The fixture checks (`verify` in `corpus.ts`) run
hand-written Playwright checks against each fixture; they validate the fixtures, not a discovery suggestion. The
platform path for a discovery suggestion is covered by `tests/e2e/platform-discovery.spec.ts`, which runs an unedited
suggestion through Stagehand and the Playwright rerun.

## Reproduce the scripted smoke

Build the image (`docker build -t vtp-browser-use-discovery:1.0.6 apps/browser-use-discovery`), run
`uv sync --frozen` in `apps/browser-use-discovery`, install the repository's Playwright Chromium, and start the
loopback fixture:

```sh
apps/browser-use-discovery/bin/serve-fixture --port 4599
BROWSER_USE_BENCHMARK=1 pnpm test:integration tests/integration/survey-stage.test.ts -t 'ten-site Browser Use fixture benchmark'
```

It writes `.artifacts/discovery-benchmark/results.json` and `candidates-for-rating.json`. `results.json` records:

- `provenance`: generation time, `sourceRevision` (HEAD), `dirty` plus a `dirtyFingerprint` (SHA-256 over the diff
  against HEAD and every untracked file), the local image tag and `id`, `contentMatchesTree` (whether the image's
  runner and fixture files equal the tree's), the Browser Use pin and the Node version;
- `complete`: every fixture ran, discovery completed, and every fixture check passed;
- `smoke`: rubric checks matched by the standard and the enriched survey, ideas offered and matched, fixture checks,
  the largest agent-container peak memory, and added latency (p50, p95 and max);
- `usefulness`: `not_measured`, with the open gates.

## Local scripted smoke reference

Generated 2026-11-23 from `669de25` plus uncommitted work (`dirty: true`; see the file's fingerprint) with the local
image whose files match the tree (`contentMatchesTree: true`). Scripted models only.

| Measure | Result |
|---|---:|
| Fixtures completed, with passing fixture checks | 10 of 10 |
| Rubric checks matched by the standard survey | 10 |
| Rubric checks matched after Browser Use enrichment | 11 |
| Scripted Browser Use ideas offered / matching a rubric check | 19 / 10 |
| Added latency, p50 / max (scripted model, container start included) | about 3.9 s / 6.2 s |
| Agent container peak memory per job (host-sampled, limit 2 GiB) | about 290–330 MiB |

The one additional check (the support disclosure) comes from a scripted DOM heuristic. These numbers say nothing
about a hosted model's usefulness, and the plan's ≥25 % coverage-gain and ≥70 % useful-rate targets remain
unmeasured. An earlier run of this harness reported 10 → 12 checks; it used asymmetric matching (an exact
requirement for the survey, a loose title pattern for Browser Use) and rubric patterns keyed to the scripted
titles, and has been withdrawn.

## Zero-cost local-model evaluation (2026-11-24)

The harness accepts a `local:<model>` discovery model served on this host's loopback (no provider, recorded cost
0). Results and worksheets go to `results.local-<model>.json` and `candidates-for-rating.local-<model>.json`.

| Measure (`local:openai/gpt-oss-20b`, LM Studio, ten fixtures) | Result |
|---|---:|
| Browser Use outcomes | 8 `PARTIAL` (no valid candidates), 2 `FAILED` |
| Reviewable Browser Use ideas | 0 |
| Standard-survey ideas in the mixed worksheet | 30 (unrated) |
| Independent fixture checks passed | 10 of 10 |
| Added latency p50 / p95 | 21.5 s / 68.1 s |
| Agent container peak memory | about 330 MiB |

On one fixture `local:qwen/qwen3.5-9b` used its whole 115 s job budget. The available local models do not produce
reviewable candidates, so usefulness, new coverage and the unedited execution and confirmation rates cannot be
measured from them. This is not a hosted-provider evaluation and not a human rating.

## Provider evaluation (DeepSeek `deepseek-flash`, 2026-11-24)

The run was approved with a USD 0.25 cap (`BROWSER_USE_BENCHMARK_MAX_COST_USD`; the harness stops before a job that could pass the cap, or after any job whose cost is unknown).

| Measure | Result |
|---|---:|
| Fixtures completed, with passing fixture checks | 10 of 10 |
| Browser Use ideas offered / matching a rubric check | 56 / 15 |
| Ideas inside their own fixture (post-hoc scope rule) | 22 of 56 |
| Rubric checks: standard survey → enriched | 10 → 11 |
| Model cost | USD 0.152 |
| Added latency p50 / p95 | 64.4 s / 87.0 s |
| Agent container peak memory | 385 MiB |

On six benchmark fixtures the agent left `/benchmark/<fixture>/` for the tea shop at `/`. Grounding now keeps only paths
under the start page's directory, and the task names that scope. This run predates that fix. The worksheet
`candidates-for-rating.hosted.json` (86 ideas) is unrated.

Three in-scope candidates ran **unedited** through Stagehand and the Playwright rerun
(`tests/e2e/platform-discovery-confirm.spec.ts`, `E2E_MODE=live`, USD 0.026; result in `confirmation.hosted.json`).
None executed to a verdict on every criterion and none were confirmed: museum ended `INCONCLUSIVE` with 14 derived
criteria, and academy and library ended `ERRORED`.

The fixture pilot now asks for one action or short sequence and one observable outcome per idea. Invalid-input cases
can be offered as their own ideas. The executable requirement combines the goal and first expected result. The review
and report still carry the fixture paths. The scripted smoke passed on all ten fixtures, and the platform E2E selected
an unedited suggestion, clicked the Products link, and verified the exact heading text in Playwright. A new hosted
run is needed to measure the effect on execution and confirmation across model-generated ideas.

A zero-cost follow-up with `local:openai/gpt-oss-20b` covered the same three confirmation fixtures (museum, library,
academy). All three independent fixture checks passed. Discovery returned zero candidates again (two `PARTIAL`,
one `FAILED`), so the follow-up yielded no model-generated suggestions for unedited execution.

## Hosted-model evaluation (mechanism)

With an approved budget, put `DISCOVERY_MODEL` and the provider key in a discovery env file that only the operator
can read, then:

```sh
BROWSER_USE_BENCHMARK=1 BROWSER_USE_BENCHMARK_ENV_FILE=/secure/path/discovery.env \
  pnpm test:integration tests/integration/survey-stage.test.ts -t 'ten-site Browser Use fixture benchmark'
```

The launcher's per-fixture config sources that file on the host. The harness reads its `DISCOVERY_MODEL` line and
uses the same fixture image as the scripted smoke. A hosted run may fall back on some fixtures. Each row records the
outcome, including the number of ideas returned by the broker and how many were offered after merge.

Give the reviewer `candidates-for-rating.hosted.json`. It mixes the standard and Browser Use ideas without explicit
source labels. Set `useful` to `true` for a grounded, actionable and worthwhile scenario and `false` otherwise.
For each `true`, set `scenario` to a short lowercase identifier such as `catalog-search`. Use the same identifier for
ideas on the same fixture that cover the same behavior. Leave `scenario` null for `false`. Keep all IDs and idea text
as generated. Then score the paired files:

```sh
pnpm exec tsx evals/discovery/score-ratings.ts \
  .artifacts/discovery-benchmark/results.hosted.json \
  .artifacts/discovery-benchmark/candidates-for-rating.hosted.json
```

The scorer divides distinct useful discovery scenarios by all candidates returned by the broker. Candidates that
the merge does not offer reduce that rate. New coverage is distinct useful discovery scenarios absent from the
baseline, divided by distinct useful baseline scenarios. Cost per useful candidate uses the estimated discovery
model cost across all fixtures and stays unmeasured if any fixture lacks a price. The scorer reports p50 and p95
latency, includes fixture fallbacks, and withholds quality scores until the worksheet is complete. The standard survey
uses a scripted baseline. Browser and infrastructure costs, Stagehand execution rate, and independent Playwright
confirmation rate still need separate evidence.

## Hosted smoke history

Five bounded hosted attempts on the community noticeboard (2026-11-23, `.artifacts/discovery-benchmark/hosted-*.json`)
returned no reviewable ideas: two DeepSeek attempts failed with a provider-side `UserError`, two ended `PARTIAL` with no valid candidates (the larger used 12 model calls, an estimated $0.0056, and
42.8 s), and an Anthropic attempt stopped at authentication. They verified provider connectivity and cost recording
only. With no candidates returned, they also say nothing about prompt-injection resistance.
