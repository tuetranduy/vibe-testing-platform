# Discovery evidence and replay fixes

The Shopware regression cases now work through AI planning, live exploration, test generation and Playwright replay. The original confirmed criteria are reused unchanged for the controlled regression: no explicit test source, facts, verdicts or manual reviews are imported.

Current suite: [Shopware AI discovery regression](http://localhost:3000/suites/ste_0mw9b3x54db0d6796ab28fa6a).

| Case | Original criteria | Discovery and generated replay |
| --- | ---: | --- |
| Cart lifecycle | 20 | 20 pass |
| Guest wishlist gate | 11 | 11 pass |
| Registration account type | 14 | 14 pass |
| Nonexistent search | 6 | 3 pass, 3 fail on the real search defect |

All 51 criteria are compiled and replay-confirmed, with no omitted, blocked or inconclusive criteria. The search defect remains a failure: the store returns unrelated products for the nonexistent query.

The [final independent suite replay](http://localhost:3000/suite-runs/srn_0mw9b3x9a9b21fc792aa15899) also matched every discovery assertion: 3 cases passed and the search case failed, totaling 48 passing checks and 3 failing checks. There were zero inconclusive results. The verifier checked the pinned source and every criterion status against the discovery reports.

## Changes

- Named field values are read from the DOM. Required markers and dialog scope are handled explicitly. Duplicate or vague targets fall back instead of manufacturing evidence. Visibility facts for missing fields, removed product lines and closed dialogs retain locators that can detect their reappearance.
- Label locators can preserve substring matching for required markers; existing stored locators still default to exact matching. The compiler replays the same matching semantics.
- Labeled amounts can be read from the adjacent value in the nearest row. This requires the requested description to identify the label; the reader does not search other rows for a matching amount.
- Generated text checks on inputs poll their values, rather than asserting against empty text content. Older field facts recorded in text mode are handled too.
- The early notification reader no longer treats the entire login dialog as evidence for an input, heading or button inside it. These children receive their own locators and assertions.
- Scroll, hover and double-click actions preserve their actual method through exploration and replay. A quoted nearby link no longer turns a scroll into navigation.
- Reload instructions retain the current URL, including its search query. A lookup returning one repeated result card is grounded to its owning list before counting, so internal card components are not mistaken for products.
- When exploration observed an action navigating to another URL, generated replay waits for that destination before checking the next page. This handles SPA transitions that outlast the short network-settle window.

The stored source guard remains in place. Only the browser methods needed for these recorded actions and URL synchronization were added to its existing allowlist.

## Validation

- Testing engine: 860 tests pass across 41 files, including real Chromium regression fixtures.
- Shared contracts: 154 tests pass. Engine type checking passes.
- The original 51 criteria and fact requests were compared unchanged with their source runs before the AI suite was collected. Every result has `PLAYWRIGHT_RERUN` evidence.
- Fresh requirement analysis also passed the cart and registration flows. Controlled regression then reused the original criteria to ensure differences in model-generated criteria could not hide missing checks.

The local API, worker and runner were rebuilt and updated. Original discovery attempts and the initial explicit-test suite remain in history.

To inspect or rerun the controlled regression:

```sh
pnpm exec tsx tests/shopware/recheck-discovery.ts
SHOPWARE_RUN_SET=discovery-confirmed-v2 node tests/shopware/platform.mjs status
SHOPWARE_RUN_SET=discovery-confirmed-v2 node tests/shopware/platform.mjs progress
SHOPWARE_RUN_SET=discovery-confirmed-v2 node tests/shopware/platform.mjs collect
SHOPWARE_RUN_SET=discovery-confirmed-v2 node tests/shopware/platform.mjs suite-status
```

The recheck utility uses the local administrator's configured database and queue. It creates new discovery runs from the original confirmed criteria and existing site-analysis context, then invokes the normal AI execution queue. It copies no generated code, observed facts or results. Capacity-limited cases can be submitted again when a slot opens. New attempts can use `--retry`, `SHOPWARE_CASE_ID` and a new `SHOPWARE_RECHECK_REVISION` without overwriting history.

Reports and machine-checked suite verification are under `.artifacts/shopware/discovery-confirmed-v2/`. The suite verifier compares every assertion's status and the pinned generated source against its discovery run.
