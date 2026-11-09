# Shopware complex flow regression cases

Test target: https://frontends-demo.vercel.app/ — verified November 9, 2026.

Each direct test starts in a new Chromium context, uses real page interactions, and records a screenshot, page text and Playwright trace. Tests wait for the client-rendered Sign in button before interacting. Cart checks wait for the updated notification or amounts; search checks wait for hydration and network idle. A browser timeout is an execution error, never evidence of the known search defect.

| Case | Checks | Direct baseline |
| --- | --- | --- |
| Cart lifecycle | Add quantity 2; line €19.80; subtotal €19.80 + shipping €20 = total €39.80; update to 3; line/subtotal €29.70, total €49.70; persist after reload; remove final item; empty cart persists after reload | PASSED |
| Guest wishlist gate | Smoking Board Cedar Wood wishlist action opens login dialog; email/password/sign-in/signup present; signup navigates to registration and closes dialog | PASSED |
| Registration account type | Private hides Company/VAT fields; Company reveals them; switching twice preserves first and last names | PASSED |
| Nonexistent search | Search `codex-no-product-20261109`; verify zero results before and after reload | FAILED: four unrelated products before and after reload |

Current AI-generated suite: [Shopware AI discovery regression](http://localhost:3000/suites/ste_0mw9b3x54db0d6796ab28fa6a). The discovery engine now compiles and replay-confirms all 51 original criteria. See [the engine fixes and validation](discovery-evidence-fixes.md).

Initial explicit-test suite, retained as a baseline: [Shopware verified complex flows](http://localhost:3000/suites/ste_0mw99sxe8bbe5c16ab39fe28e).

The [final suite run](http://localhost:3000/suite-runs/srn_0mw99sxfpfb0e9ee2a4b2af4e) completed with 3 passed cases and 1 failed case, zero inconclusive cases. Each saved source and every criterion outcome matched the preceding explicit run. The suite is correctly marked FAILED because it reproduces the search defect. Verification details are recorded in `.artifacts/shopware/verification.json`.

The explicit saved tests reproduce the direct baseline inside the platform: 20/20 cart checks pass, 11/11 wishlist checks pass, 14/14 registration checks pass, and the search case has 3 passing setup checks and 3 failing result checks. All 51 checks are backed by the platform's Playwright runner, with no inconclusive results.

The initial AI discovery runs remain in history. They reported the search defect correctly, but the three healthy flows were inconclusive because some visibility, absence, price and input-value facts were not grounded correctly. Those gaps were subsequently fixed in the discovery and replay engine and verified against the unchanged original criteria. The initial explicit suite below remains an independent baseline. No manual verdict overrides were applied.

The unrelated search results are ILARIO Product Variants, LAVENDA Product Variants, LINE Product Variants and Spatial 3D product. Their ordering varies. This is a product failure, not a passing baseline. The test continues to expect zero products.

The mini-cart labels its amount including shipping “Subtotal.” The full cart shows the merchandise subtotal and shipping separately. The cart test deliberately checks full-cart financial totals and the mini-cart line price.

## Run and inspect the initial baseline

```sh
node tests/shopware/verify.mjs
node tests/shopware/platform.mjs submit
node tests/shopware/platform.mjs progress
node tests/shopware/platform.mjs status
pnpm exec tsx tests/shopware/import-native.ts import
pnpm exec tsx tests/shopware/import-native.ts status
pnpm exec tsx tests/shopware/import-native.ts suite
pnpm exec tsx tests/shopware/import-native.ts suite-status
```

The direct runner exits nonzero when the search defect reproduces. A matching expected failure remains a failure. An optional case ID runs only that case and preserves the other baseline records.

`cases.json` contains the full plain-language instructions submitted to the platform. Submission requires a matching direct baseline, creates discovery runs through the public service API using the configured model, enables criteria confirmation and generated-test replay, and preserves run IDs in `.artifacts/shopware/platform.json`. Repeated submission skips existing cases; when the platform reaches its active-run limit, submit again after a slot opens. No account or order is created.

`build-native.ts` is the canonical source of the explicit test recipes. It emits the same restricted source grammar and fixed helpers as the platform compiler, and checks the source before importing it. `native-criteria.json` pins the reviewed criterion mapping so a future discovery result cannot silently change what an assertion means. Navigation to the current cart/results URL performs the reload checkpoints while retaining browser session state.

`import-native.ts` is a local administrator utility using the configured database/queue. The application has no public arbitrary-code import endpoint. It inserts new test snapshots through the existing repositories, copies the confirmed criteria, and enqueues the normal saved-test runner. It does not modify discovery runs or import verdicts. Source changes produce new snapshots with source hashes and provenance notes. Attempts rejected by the source guard or superseded during verification remain in history; only the final fully verified snapshots are pinned to the suite. The guard was kept intact.

The suite pins the exact imported snapshots through the suite repository. The ordinary UI Add to suite action resolves a rerun to its original discovery source, so using that action for these imported snapshots would select the incomplete generated tests. Run this saved suite directly to preserve the reviewed coverage.

Outputs are in `.artifacts/shopware/` (ignored by Git): `baseline.json`, per-case screenshots/text/traces, discovery reports, explicit-run reports, source bundles, `native.json` and `native-suite-run.json`. Service-created runs and the suite are visible to platform administrators. The verified suite is created only after every explicit run finishes with the expected verdict and zero blocked/inconclusive checks.
