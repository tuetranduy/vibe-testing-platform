# Generated inputs and no secret redaction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A run never blocks for a value nobody provided (test data or a secret): it is generated from the page. Run
secrets are no longer redacted from anything the platform shows or stores.

**Architecture:** Redaction of run secrets is removed at its source (`@platform/security`) and every caller follows
the compiler. Generated values are made in the executor's fill path, stored on the fill's exploration step
(`generatedValue`), and read from the steps by verification, the Playwright compiler and the report.

**Tech Stack:** TypeScript, Zod contracts, Drizzle (Postgres), Playwright, Vitest, Next.js.

**Spec:** `docs/superpowers/specs/2026-10-07-generated-inputs-no-redaction-design.md`

## Global Constraints

- Key-based redaction (`SENSITIVE_KEYS`, `isSensitiveKey`, `redactByKey`) and the logger's own redaction stay.
- Secrets stay encrypted at rest and purged when a run ends; a rerun still asks for typed secrets.
- `MISSING_SECRET` / `MISSING_TEST_DATA` stay in `BlockReasonSchema` (old runs); only the verifier still produces
  `MISSING_TEST_DATA` (a `testDataKey` check with no value anywhere).
- `ArtifactSensitivitySchema` keeps both values (old rows); new artifacts are always `STANDARD`.
- Generation never blocks: a failed or unusable model answer falls back to a deterministic value.
- One model call per generated key per run; later fills of the same `source:key` reuse the value.

## Review Focus

- A select whose generated value is not one of its options → the first non-empty option is used (Task B3 test).
- The same key filled in two scenarios (sign-up, then login) → the same value both times (Task B4 test).
- A run on the fake engine / `ctx.llm === null` → fallback values, no throw (Task B3 test).
- An old run whose artifacts are `SECRET_BEARING` → served without `reveal=true` (Task A2 test).
- A text check on a key that a fill generated → compared with the generated value, not blocked (Task B5 test).

---

## Part A — no redaction of run secrets

### Task A1: Run redactor is key-based only

**Files:**
- Modify: `packages/security/src/redaction.ts`, `packages/security/src/secret-fingerprint.ts`, `packages/security/src/index.ts`
- Modify (callers): `apps/worker/src/run-context.ts:68`, `apps/api/src/services/{test-run,rerun,suite-run}-service.ts`,
  `packages/testing-engine/src/playwright-runner/runner.ts:198`, `apps/worker/src/sandbox/runner-process.ts:119`,
  `packages/testing-engine/src/exploration/executor.ts` (fill error masking, ~line 690)
- Test: `packages/security/src/redaction.test.ts`, the callers' tests

**Interfaces:**
- Produces: `createRunRedactor(): (value: unknown) => unknown` (key-based only; no parameter).
  `createValueRedactor`, `redactFingerprintedSecrets`, `containsFingerprintedSecret` are deleted.
  `secretFingerprint` stays (rows still get a fingerprint; harmless, keeps the schema unchanged).

- [ ] **Step 1:** In `redaction.test.ts`, replace the value-redaction tests with: `createRunRedactor()` keeps a
  string containing a former secret value unchanged, and still redacts `{ password: "x", authorization: "y" }`.
- [ ] **Step 2:** Run `cd packages/security && pnpm exec vitest run` → FAIL.
- [ ] **Step 3:** Implement; delete the value-based helpers; fix every caller until `pnpm -r typecheck` passes. The
  rerun's stdout/stderr and the executor's fill errors are no longer masked.
- [ ] **Step 4:** Update the callers' tests that asserted `[REDACTED]` for a secret value to assert the value is kept
  (`grep -rln "REDACTED" packages apps --include=*.test.ts`); keep key-based assertions. Run the affected packages'
  suites → PASS.
- [ ] **Step 5:** Commit `feat(security)!: run secrets are no longer redacted; the run redactor is key-based only`.

### Task A2: Evidence is never secret-bearing; no Reveal step

**Files:**
- Delete: `packages/testing-engine/src/evidence/trace-scrubber.ts` (+ test)
- Modify: `packages/testing-engine/src/evidence/collector.ts`, `exploration/executor.ts:345`, `exploration/explore-stage.ts`,
  `survey/site-reader.ts:80`, `apps/api/src/routes/artifacts.ts`, `apps/web/lib/artifacts.ts`,
  `apps/web/components/ArtifactList.tsx`, `apps/web/components/NewTestForm.tsx:709`
- Test: `collector.test.ts`, `apps/api/src/routes/artifacts.test.ts`, `ArtifactList.test.tsx`

**Interfaces:**
- Produces: `collectEvidence(ctx, files, { store })` (no `secretValues`); every new artifact `STANDARD`.
  `requiresReveal` deleted from the web app.

- [ ] **Step 1:** Tests: a collected trace keeps a secret value and is `STANDARD`; `GET …/artifacts/:id` of a
  `SECRET_BEARING` row without `reveal` → 200 and no `audit_events` row; `ArtifactList` loads every artifact without
  a Reveal button.
- [ ] **Step 2:** Run them → FAIL.
- [ ] **Step 3:** Implement. Form copy: "Credentials such as a password: encrypted at rest and deleted when the run
  ends."
- [ ] **Step 4:** Run engine, api and web suites → PASS.
- [ ] **Step 5:** Commit `feat: evidence is never secret-bearing; artifacts need no reveal`.

### Task A3: No fingerprint checks in the API

**Files:**
- Modify: `apps/api/src/services/suggestion-service.ts:93-101`, `apps/api/src/services/criteria-service.ts:122-128,203-206`
- Test: their tests

- [ ] **Step 1:** Tests: an edited suggestion whose text contains a secret value is stored as typed; criteria edits
  and confirmation test data containing a secret value are accepted (200).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Remove `findSecretValue` and the fingerprint redaction (key-based
  `redactByKey` stays). **Step 4:** api suite → PASS.
- [ ] **Step 5:** Commit `feat(api): secrets typed into edited text are no longer detected or masked (reverses KI-022)`.

### Task A4: E2E and docs for Part A

**Files:** `tests/e2e/platform-*.spec.ts` (secret-hygiene assertions), `README.md`, `docs/known-issues.md` (KI-022,
KI-028 notes), `docs/operations.md` (secret artifact retention now unused for new artifacts).

- [ ] **Step 1:** Change E2E assertions that a secret never appears into assertions that it is shown (or drop them
  where they only guarded hygiene). Run `pnpm test:e2e` → PASS.
- [ ] **Step 2:** Docs. Commit `docs: run secrets are shown, not redacted (2026-10-07)`.

## Part B — generated inputs

### Task B1: Contracts and storage

**Files:**
- Modify: `packages/contracts/src/exploration.ts` (`ExplorationStepSchema`), `packages/contracts/src/report.ts`,
  `packages/db/src/schema.ts` (`exploration_steps`), `packages/db/src/exploration-repository.ts`
- Create: migration `packages/db/migrations/0017_*.sql` (via `drizzle-kit generate`), `packages/testing-engine/src/shared/generated-inputs.ts`
- Test: `exploration-repository.test.ts`, `shared/generated-inputs.test.ts`

**Interfaces:**
- Produces: `ExplorationStep.generatedValue: string | null` (default null);
  `GeneratedInputSchema = { source: "testData" | "secret", key: string, value: string, stepId: string }`;
  `TestReport.generatedInputs: GeneratedInput[]` (default []);
  `generatedInputs(steps: readonly ExplorationStep[]): GeneratedInput[]` (first step per `source:key`, step order);
  `generatedTestData(steps): Record<string, string>` (testData entries only).

- [ ] Steps: failing tests (round-trip of `generatedValue`; the helpers dedupe by `source:key`) → implement →
  `pnpm --filter @platform/db test` and engine test → commit `feat: an exploration step can carry the value it generated`.

### Task B2: Planning never blocks for a missing input

**Files:** `packages/testing-engine/src/planner/blocking.ts`, `blocking.test.ts`,
`evals/planner/cases/04-login-missing-secret.yaml`, `13-quantity-missing-test-data.yaml`

- [ ] Steps: tests (a step with an unprovided secret / test data `inputRef`, and a `test_data` precondition without a
  value, block nothing; destructive blocking unchanged) → remove `missingInput` and its precedence text → eval cases
  expect `blocked: []` → engine suite → commit `feat(planner): a missing secret or test data value never blocks a check`.

### Task B3: Input generator

**Files:**
- Create: `packages/testing-engine/src/exploration/input-generator.ts` (+ test)
- Modify: `exploration/recorder.ts` (field reading), `RecorderPort` in `executor.ts`

**Interfaces:**
- Produces:
  - `RecorderPort.describeField?(page, selector): Promise<FieldFacts>`;
    `FieldFacts = { tag: string; type: string | null; name: string | null; label: string | null; placeholder: string | null; autocomplete: string | null; maxLength: number | null; min: string | null; max: string | null; pattern: string | null; options: { value: string; label: string }[] }` (options capped at 50).
  - `InputGenerator.generate(req: { source: "testData" | "secret"; key: string; stepDescription: string; field: FieldFacts; runId: string; signal: AbortSignal }): Promise<{ value: string; llm: LlmStepUsage | null }>`.
  - `createInputGenerator(llm: LlmClient | null): InputGenerator` — one `generateStructured` call
    (`schemaName: "generate_input"`, `{ value: string }`, `stage: "EXPLORING"`), then `fitToField(value, field)`;
    fallback when `llm` is null, the call throws or the value is empty: `generateTestDataValue(key, …)` for test
    data, else a random 16-character password with upper, lower, digit and symbol.
  - `fitToField(value, field): string` — a select keeps the value if it equals an option's value or label (returns the
    value), else the first non-empty option value; otherwise cut to `maxLength`.

- [ ] Steps: tests (model answer used; select off-list → first option; `maxLength` cut; `llm: null` → fallback for
  both sources; model throws → fallback) → implement → engine suite → commit `feat(exploration): generate a value for a field from the page`.

### Task B4: Executor generates instead of blocking

**Files:** `packages/testing-engine/src/exploration/executor.ts` (`resolveInput`, `fill`, `executePlanned`,
`ExplorationDeps`), `executor.test.ts:485-505`, `explore-stage.ts` (passes `createInputGenerator(ctx.llm)`)

**Interfaces:**
- Consumes: B1 `generatedValue`, B3 `InputGenerator`, `describeField`.
- Produces: `ExplorationDeps.inputs?: InputGenerator` (default `createInputGenerator(ctx.llm)`).

- [ ] Steps: replace the `it.each` "never invented" test with: an unprovided secret / test data ref is generated
  after the field is located, filled, and recorded `SUCCESS` with `generatedValue`; a second fill of the same key in a
  later scenario reuses it with one generator call; a provided value has `generatedValue: null` → implement
  (`resolveInput` returns `string | null`; `fill` generates after locating and before `enforcePolicy`, caching in a
  `Map<"source:key", string>`) → engine suite → commit `feat(exploration): a fill with no value generates one from its field`.

### Task B5: Verification, compiled test and report use generated values

**Files:** `verification/verify-stage.ts:22`, `compiler/generate-stage.ts:47`, `compiler/test-compiler.ts:257-260,613-620`,
`reporting/report-builder.ts`, `apps/web/components/RunReport.tsx` (+ tests)

- [ ] Steps: tests (a `testDataKey` check on a generated key is verified against it; the compiler compiles a fill of
  an unprovided secret with `generatedValue` from `run-data.json`, not `SECRET_*`; the report lists
  `generatedInputs`; `RunReport` shows a "Generated inputs" list: key, "secret" or "test data", value) → implement
  (`{ ...ctx.request.testData, ...generatedTestData(exploration.steps) }`) → suites → commit
  `feat: generated values reach verification, the saved test and the report`.

### Task B6: Suggested test data applied on every execution

**Files:** `orchestrator/orchestrator.ts` (`RunPorts`, `runExecution`), `apps/worker/src/run-context.ts`, orchestrator tests

**Interfaces:** `RunPorts.getSiteAnalysis(): Promise<SiteAnalysis | null>`.

- [ ] Steps: test (a manually confirmed run whose suggestions were not accepted gets them before planning; a key the
  user set is not replaced) → implement (apply suggestions whose keys `ctx.request.testData` lacks, via
  `applyTestData`) → suites → commit `feat: suggested test data is used whenever the user did not give a value`.

### Task B7: E2E, docs, full verification

- [ ] CI E2E specs expecting `MISSING_*` from the real planner are updated; `pnpm -r typecheck`, `pnpm test`,
  `pnpm test:integration`, `pnpm test:e2e` → PASS. README section and known-issues note. Commit `docs: generated inputs (2026-10-07)`.
