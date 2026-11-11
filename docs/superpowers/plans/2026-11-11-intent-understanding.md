# Intent Understanding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A short or vague requirement produces a real test of the feature the user meant, with every assumption the platform made shown in the review and the report.

**Architecture:** The existing compile call also returns the user's intent and may add inferred criteria. Deterministic code keeps an inferred criterion only when it is grounded in the pages read, and salvages a partly invalid answer instead of failing the run. The new data rides on optional fields of the stored criteria JSON, so there is no migration; the planner prompt, criteria editing, the review UI and the reports read those fields.

**Tech Stack:** TypeScript, Zod 4.4.3, Vitest, React (Next.js, Testing Library), pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-11-11-intent-understanding-design.md`

## Global Constraints

- New contract fields are optional or defaulted: stored revisions, saved tests, suites and scripted answers must parse unchanged. No database migration.
- `sourceText` stays a verbatim substring of `originalText` for stated **and** inferred criteria.
- At most 5 inferred criteria. An inferred criterion has a `rationale`; a stated one has none.
- Inferred criteria are `critical: true` (they count toward the verdict).
- A missing `intent` is treated as `specific`: no inferred criteria.
- No extra model call. The model client (`packages/llm`) is not changed.
- Safety is untouched: destructive-action blocking, host allowlist, planner blocking, verification rules.
- Field length limits: `rationale` and `assumption` 3–300, `intent.goal` 3–300, `intent.feature` 1–80, `intent.notes` at most 10 entries of at most 300.
- No commit and no push without the owner asking: a push to `main` deploys to production. The "Commit" steps below are run only on a feature branch and only after the owner says so; otherwise leave the work in the tree.
- Prompts are untrusted-data safe: page and requirement text stay between the existing markers.

## Review Focus

- A model that marks **every** criterion inferred for a specific requirement: the run must still have criteria (they are dropped → whole-requirement fallback), never an empty list. *(Task 2 test.)*
- An inferred criterion whose facts are shared with a stated one: dropping it must not remove the shared fact. *(Task 2 test.)*
- A stored revision written before this change (no `origin`, no `intent`) opened in review and edited: the PUT must succeed. *(Task 5 test.)*
- A run whose only critical criteria are inferred and one of them FAILS: the report must say FAILED plainly, with the badge, and not soften it with "assumed". *(Task 7 test.)*
- `intent.goal` or a `rationale` containing Markdown or HTML: it must be escaped in the Markdown report and rendered as text in the UI. *(Task 6 and Task 7 tests.)*

---

### Task 1: Contract fields

**Files:**
- Modify: `packages/contracts/src/requirement.ts`
- Test: `packages/contracts/src/contracts.test.ts`

**Interfaces:**
- Produces: `AcceptanceCriterion.origin: "stated" | "inferred"`, `.rationale: string | null`, `.assumption: string | null`; `RequirementIntentSchema` / `type RequirementIntent = { clarity: "specific" | "feature" | "vague" | "site_wide"; goal: string; feature: string | null; notes: string[] }`; `NormalizedRequirement.intent?: RequirementIntent | null`; `MAX_INFERRED_CRITERIA = 5`.

- [ ] **Step 1: Write the failing tests** in a new `describe("intent and inferred criteria")`:
  - a requirement object with no `origin`, `rationale`, `assumption` or `intent` parses, and each criterion comes back with `origin: "stated"`, `rationale: null`, `assumption: null`;
  - an inferred criterion without a rationale is rejected with the message `An inferred criterion says why it was added`;
  - a stated criterion with a rationale is rejected with `Only an inferred criterion has a rationale`;
  - 6 inferred criteria are rejected with `At most 5 inferred criteria`;
  - an inferred criterion whose `sourceText` is not in `originalText` is rejected with the existing verbatim message;
  - an intent with `clarity: "vague"`, a goal and `feature: null` parses with `notes: []`.
- [ ] **Step 2: Run** `pnpm --filter @platform/contracts test` — the new tests fail.
- [ ] **Step 3: Implement** the fields exactly as in spec section 4 and the three rules in `superRefine`. Export `RequirementIntentSchema`, `RequirementIntent`, `MAX_INFERRED_CRITERIA`.
- [ ] **Step 4: Run** `pnpm --filter @platform/contracts test` and `pnpm typecheck` — pass. Fix any consumer that builds an `AcceptanceCriterion` literal without the new fields by using the schema's input type or adding the defaults.
- [ ] **Step 5: Commit** `feat(contracts): criteria carry their origin; a requirement carries its intent`

### Task 2: Grounding and salvage (deterministic)

**Files:**
- Create: `packages/testing-engine/src/requirement/intent.ts`
- Test: `packages/testing-engine/src/requirement/intent.test.ts`
- Modify: `packages/testing-engine/src/requirement/model-output.ts`

**Interfaces:**
- Consumes: Task 1 types; `DESTRUCTIVE_TERMS` / `assertActionAllowed` from `@platform/security`.
- Produces:
  - `CompilerOutputSchema` gains `intent: { clarity, goal, feature } | null` (default null) and per-criterion `origin`, `rationale`, `assumption` (defaulted).
  - `groundInferred(output: CompilerOutput, ctx: { pagesRead: boolean; secretNames: readonly string[] }): { output: CompilerOutput; notes: string[] }`
  - `salvage(output: CompilerOutput, issues: readonly string[]): { output: CompilerOutput; notes: string[] } | null` — null when no criterion survives.
  - `wholeRequirementFallback(originalText: string): Pick<CompilerOutput, "criteria" | "facts">`
  - `LEFT_OUT = (statement: string, why: string) => \`Left out: ${statement} (${why})\``
  - `WHOLE_REQUIREMENT_NOTE = "The requirement could not be split into checks; it is judged as a whole from what the pages show"`

- [ ] **Step 1: Write the failing tests.** Use a helper `out(criteria, { clarity, siteChecks })` that builds a `CompilerOutput` with one boolean fact per criterion at checkpoint `cp_<n>`.
  - `groundInferred`, one test per row of spec 5.3: clarity `specific` → inferred dropped; `intent: null` → dropped; `pagesRead: false` → dropped; site check missing / `not_found` / `unclear` → dropped; statement "Delete the account and confirm it is gone" → dropped; a `secret` precondition whose `ref` is not in `secretNames` → dropped; 7 grounded inferred → first 5 kept.
  - each drop adds `LEFT_OUT(statement, why)` with `why` one of: `the requirement already says what to check`, `no pages of the site were read`, `the pages read do not show it`, `it would change or delete data`, `it needs a credential the run does not have`, `more than 5 checks were added`.
  - a stated criterion is never dropped, whatever its site check.
  - after dropping criterion 2 of 3, `siteChecks` entries for criterion 3 are renumbered to 2 and the dropped one's entry is gone.
  - *(Review Focus)* a fact read by both a dropped inferred criterion and a kept stated one stays; a fact only the dropped one read is removed.
  - *(Review Focus)* every criterion inferred + clarity `specific` → `output.criteria` is empty (the caller applies the fallback).
  - `salvage`: issues `["criteria.1.expectedOutcome.fact: Fact x@y is not declared"]` drops criterion index 1, keeps 0 and 2, note `LEFT_OUT(statement, "could not be turned into a check")`; an issue with no `criteria.<i>` path (`facts.0.key: …`) returns null; all criteria named → null.
  - `wholeRequirementFallback("Test the search")` returns one criterion: `sourceText` and semantic `description` equal to the text, `origin: "stated"`, `ambiguity: null`, no facts. A text shorter than 3 characters uses the description `The requirement holds`.
- [ ] **Step 2: Run** `pnpm --filter @platform/testing-engine exec vitest run src/requirement/intent.test.ts` — fails.
- [ ] **Step 3: Implement.** The destructive test is `assertActionAllowed({ kind: "click", description: statement }, { allowDestructive: false })` not being allowed (use the descriptor shape that file exports). Fact cleanup: a fact is removed only when no remaining criterion's `factRefsOf` names it.
- [ ] **Step 4: Run** the test file and `pnpm --filter @platform/testing-engine typecheck` — pass.
- [ ] **Step 5: Commit** `feat(engine): keep an inferred criterion only when the pages read show it`

### Task 3: Compiler wiring and prompt

**Files:**
- Modify: `packages/testing-engine/src/requirement/compiler.ts`, `prompts.ts`, `post-validate.ts`, `packages/testing-engine/src/orchestrator/stages.ts` (only if `RequirementDraft` needs it; it derives from `NormalizedRequirement`, so `intent` arrives with Task 1)
- Test: `packages/testing-engine/src/requirement/compiler.test.ts`, `post-validate.test.ts`

**Interfaces:**
- Consumes: Task 2 functions.
- Produces: `compileRequirement` returns a draft with `intent: RequirementIntent | null` (notes filled), criteria carrying `origin` / `rationale` / `assumption`; `postValidate` passes those three fields through and accepts `pagesRead`.

- [ ] **Step 1: Write the failing tests** in `compiler.test.ts` (scripted `FakeTransport` answers, as the file does today):
  - an answer with intent `feature`, one stated and two inferred criteria with `found` site checks, with `site.pages` given → the draft has 3 criteria, the last two `origin: "inferred"` with their rationale, `intent.goal` as sent, `intent.notes` empty;
  - the same answer with no `site` → 1 criterion, 2 notes, and **one** model request (no correction round spent);
  - a first answer with an undeclared fact in criterion 2, and a corrected answer with the same fault → no throw; the draft has the other criteria and a `Left out:` note; exactly 2 model requests;
  - a corrected answer where every criterion is invalid → one whole-requirement semantic criterion and `WHOLE_REQUIREMENT_NOTE`;
  - a corrected answer that is not valid against the schema still throws `ContractError`;
  - an answer with no `intent` and no `origin` fields (today's shape) → same draft as before plus `intent: null`;
  - an inferred criterion's `text_matches` with wording the requirement does not write is rewritten to `visible` (KI-070 applies to inferred criteria);
  - `title`, `siteChecks` insights and suggested test data still come out for the kept criteria (site check ids match the renumbered criteria).
- [ ] **Step 2: Run** `pnpm --filter @platform/testing-engine exec vitest run src/requirement` — the new tests fail.
- [ ] **Step 3: Implement.**
  - `check(output, context)`: run `groundInferred`, then `postValidate`; on a first answer return its issues; when `context.corrected`, return `[]` if `salvage` or the fallback can produce a valid draft.
  - After the call, apply the same pipeline to `data` to build the draft: `groundInferred` → `postValidate` → on failure `salvage` → on null `wholeRequirementFallback`. Collect all notes into `intent.notes` (when the model gave no intent and there are notes, use `{ clarity: "specific", goal: <title or first 300 chars of the requirement>, feature: null, notes }`).
  - Redact `intent.goal`, `intent.feature`, `rationale` and `assumption` with `input.redact`, and clip to the contract limits.
  - Prompt: add the blocks of spec 5.2 to `REQUIREMENT_SYSTEM_PROMPT`; keep every existing rule's text unchanged.
- [ ] **Step 4: Run** `pnpm --filter @platform/testing-engine test` and `pnpm typecheck` — pass.
- [ ] **Step 5: Commit** `feat(engine): the analysis returns the intent, adds grounded checks and never fails on one bad criterion`

### Task 4: Planner sees the intent

**Files:**
- Modify: `packages/testing-engine/src/planner/prompts.ts`, `planner.ts`
- Test: `packages/testing-engine/src/planner/planner.test.ts`

**Interfaces:**
- Consumes: `NormalizedRequirement.intent`.
- Produces: `PlannerPromptInput.requirement` also picks `intent`.

- [ ] **Step 1: Write the failing tests:** with an intent `{ goal: "A visitor can search the shop and get matching products", feature: "Search" }` the prompt contains the lines `What the user wants to know: A visitor can search the shop and get matching products` and `Feature under test: Search`, placed after the `REQUIREMENT>>>` marker; with `intent` null or absent neither line appears; each criterion in the prompt's JSON has `origin`.
- [ ] **Step 2: Run** `pnpm --filter @platform/testing-engine exec vitest run src/planner` — fails.
- [ ] **Step 3: Implement**, and add to `PLANNER_SYSTEM_PROMPT`, after the "Return JSON" block: `When the message says what the user wants to know and the feature under test, plan the path a visitor takes to use that feature; it never adds or removes a criterion.`
- [ ] **Step 4: Run** the planner tests — pass.
- [ ] **Step 5: Commit** `feat(planner): the plan is told what the user wants to know`

### Task 5: Criteria editing keeps the new fields

**Files:**
- Modify: `apps/api/src/services/criteria-edit.ts`, `apps/api/src/services/criteria-service.ts`
- Test: `apps/api/src/services/criteria-edit.test.ts`, `apps/api/src/routes/test-run-criteria.test.ts`

**Interfaces:**
- Consumes: Task 1 types.
- Produces: no new exports; the PUT's stored revision keeps `intent` from the latest revision.

- [ ] **Step 1: Write the failing tests:**
  - a body that changes `origin`, `rationale` or `assumption` of a criterion is rejected with `VALIDATION_FAILED` at that path (`origin cannot change`, `rationale cannot change`, `assumption changes only with the check`);
  - editing the check of a criterion with an `assumption` stores `assumption: null` and `ambiguity: null`;
  - removing an inferred criterion succeeds and removes facts only it read;
  - the stored revision's `intent` equals the latest revision's even when the body sends another;
  - *(Review Focus)* a latest revision stored without the new fields accepts a PUT sent by today's UI (which echoes the defaults).
- [ ] **Step 2: Run** `pnpm --filter @platform/api exec vitest run src/services/criteria-edit.test.ts src/routes/test-run-criteria.test.ts` — the new tests fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm --filter @platform/api test` — pass.
- [ ] **Step 5: Commit** `feat(api): a criteria edit cannot change where a criterion came from`

### Task 6: Markdown report

**Files:**
- Modify: `packages/testing-engine/src/reporting/markdown.ts`; create `packages/contracts/src/assumptions.ts` (exported from `index.ts`)
- Test: `packages/testing-engine/src/reporting/markdown.test.ts`, `packages/contracts/src/contracts.test.ts`

**Interfaces:**
- Produces (shared by API reports and the web app):
  - `type Assumption = { kind: "added" | "assumed" | "note"; criterionId: string | null; text: string }`
  - `assumptionsOf(requirement: Pick<NormalizedRequirement, "criteria" | "intent"> | null): Assumption[]` — `added` for each inferred criterion (text = its rationale), `assumed` for each criterion with an `assumption`, `note` for each `intent.notes` entry, in that order.
  - `passedOnAssumedChecks(report: Pick<TestReport, "verdict" | "requirement">): boolean` — true only when the verdict is `PASSED` and every critical criterion is inferred.
  - `ADDED_BY_PLATFORM = "Added by the platform"`, `PASSED_ON_ASSUMED = "Passed (on assumed checks)"`.

- [ ] **Step 1: Write the failing tests.** Contracts: `assumptionsOf` order and kinds; `passedOnAssumedChecks` is false for a FAILED run with only inferred criteria, false when one critical criterion is stated, false for a null requirement. Markdown: a report with an intent prints `**What was understood:** <goal>` under the requirement; an `## Assumptions` section lists `- AC-2 (added by the platform): <rationale>`, `- AC-1 (assumed): <assumption>` and `- <note>`; the section is absent when there are none; an inferred criterion's heading ends with ` (added by the platform)`; the verdict line reads `Passed (on assumed checks)` when `passedOnAssumedChecks`; *(Review Focus)* a goal `**bold** <script>` is escaped.
- [ ] **Step 2: Run** both test files — fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm --filter @platform/contracts test` and `pnpm --filter @platform/testing-engine test` — pass.
- [ ] **Step 5: Commit** `feat(report): the Markdown report lists what the platform assumed`

### Task 7: Review and report UI

**Files:**
- Modify: `apps/web/components/CriteriaReview.tsx`, `CriterionCard.tsx`, `CriteriaResults.tsx`, `ReportSummary.tsx`, `RunReport.tsx`, `PrintableReport.tsx`, `apps/web/app/globals.css`
- Create: `apps/web/components/Assumptions.tsx`
- Test: `apps/web/components/CriteriaReview.test.tsx`, `CriteriaResults.test.tsx`, `RunReport.test.tsx`, `PrintableReport.test.tsx`

**Interfaces:**
- Consumes: Task 6's `assumptionsOf`, `passedOnAssumedChecks`, `ADDED_BY_PLATFORM`, `PASSED_ON_ASSUMED`.
- Produces: `<Assumptions requirement={…} />` — a section titled "Assumptions", rendering nothing when `assumptionsOf` is empty.

Read `apps/web/AGENTS.md` first: this Next.js version differs from older ones.

- [ ] **Step 1: Write the failing tests:**
  - review: with an intent, a "What I understood" line shows the goal; stated criteria render before a group with the heading "Added by the platform"; an inferred card shows its rationale and keeps the Remove action; a card with an `assumption` shows `Assumed: <text>`; `intent.notes` are listed in the group; with no intent and no inferred criteria the screen is exactly as before (existing tests unchanged);
  - removing every inferred criterion removes the group heading;
  - results table: an inferred row has the badge "Added by the platform";
  - report and printable report: the Assumptions section lists the three kinds; a PASSED report resting only on inferred criteria shows "Passed (on assumed checks)"; *(Review Focus)* a FAILED one shows the normal failed headline; *(Review Focus)* a rationale containing `<b>x</b>` appears as that literal text.
- [ ] **Step 2: Run** `pnpm --filter @platform/web test` — the new tests fail.
- [ ] **Step 3: Implement,** reusing the existing card, badge and note classes; add only the group heading and badge styles.
- [ ] **Step 4: Run** `pnpm --filter @platform/web test` and `pnpm --filter @platform/web typecheck` — pass.
- [ ] **Step 5: Verify in the browser:** start `web` and `api` from `.claude/launch.json` against the local stack if it is up, open a run in review whose stored criteria include an inferred one (insert via the fake engine or a scripted answer), and screenshot the review and the report. If the stack is not available, say so instead of claiming it was checked.
- [ ] **Step 6: Commit** `feat(web): the review and the report show what the platform added and assumed`

### Task 8: Eval cases and documentation

**Files:**
- Modify: `evals/requirement-compiler/suite.ts`, `evals/BASELINE.md`, `README.md` ("Recent improvements"), `docs/known-issues.md`
- Create: `evals/requirement-compiler/cases/36-test-the-search-with-pages.yaml`, `37-login-works-with-pages.yaml`, `38-test-this-website-with-pages.yaml`, `39-look-good-show-price-with-pages.yaml`, `40-test-the-search-no-pages.yaml`

**Interfaces:**
- Produces: eval expectations `inferred: { min?: number; max?: number }`, `minStructured?: number`, `mustRecordAssumption?: boolean`; every existing case behaves as `inferred: { max: 0 }` unless it says otherwise.

- [ ] **Step 1:** Add the expectations to the suite's case schema and scoring, with a unit-style check in the suite's existing self-test if it has one (otherwise run `pnpm exec tsc -p evals/tsconfig.json`).
- [ ] **Step 2:** Write the five cases per the spec's table (section 9). Take `pages` from case 34's inventory for the Shopware demo; trim each to the start page plus the one page that shows the feature. Case 36: `inferred: { min: 1 }`, `minStructured: 2`, `noInventedText: true`. Case 37: requires a `visible` outcome and `inferred: { min: 1 }`. Case 38: `inferred: { min: 2 }`, `forbiddenOutcomeKinds: [semantic]`. Case 39: `mustRecordAssumption: true`, one `semantic` allowed. Case 40: `inferred: { max: 0 }`.
- [ ] **Step 3:** Add `inferred: { max: 0 }` to case 32 explicitly.
- [ ] **Step 4:** `pnpm typecheck` passes. Do **not** run `pnpm eval` on a paid model.
- [ ] **Step 5:** Record in `evals/BASELINE.md` that the requirement-compiler and planner prompts changed on 2026-11-11 and are not re-scored; add a known issue (next free KI number) "The intent prompts have not been scored on any model", Medium, open, with the command to close it. Add a short "Recent improvements" entry to the README.
- [ ] **Step 6: Commit** `test(evals): cases for vague, whole-site and specific requirements; docs`

### Task 9: Whole-suite verification

- [ ] **Step 1:** `pnpm typecheck` and `pnpm test` — all pass.
- [ ] **Step 2:** If Docker is running: `pnpm infra:up`, then `pnpm test:integration` and `pnpm test:e2e` — all pass (scripted answers carry no intent, so they exercise the default path). If Docker is not available, report these two suites as not run.
- [ ] **Step 3:** `git diff --check` is clean. Report what passed, what was not run, and that nothing was pushed.
