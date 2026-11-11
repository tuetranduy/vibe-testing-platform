# Intent understanding: stated and inferred criteria

**Date:** 2026-11-11 · **Status:** design approved in conversation; this spec awaits review.
**Scope:** `ANALYZING_REQUIREMENT`, the criteria review, the report, and one line of the planner prompt.
**Builds on:** `docs/superpowers/plans/2026-11-06-autonomous-unclear-requirements.md` (its items 1.1, 1.3, 1.4, 1.6
and WS4). Adaptive exploration, goal steps and replanning (its WS2.1 and WS3) are a separate, later piece.

## 1. Problem

The requirement compiler may only produce criteria copied word for word from the requirement
(`sourceText` is a verbatim substring; the prompt says "never add a criterion"). That is right for a precise
requirement and wrong for a short one:

| Requirement | Today | Why it is not what the user meant |
|---|---|---|
| "Test the search" | one `semantic` criterion, flagged ambiguous → `INCONCLUSIVE / AMBIGUOUS_CRITERION` | the user wants to know search returns matching products |
| "Make sure login works" | one criterion on the happy path | a wrong password showing an error is part of "works" |
| "Test this website" | "the website loads" → PASSED | the run is green and tested nothing |
| "…should look good and show the price" | "look good" parked as ambiguous | the model's own concrete rewrites (`ambiguity.suggestions`) are never used |

A model answer with one invalid criterion also fails the whole analysis after one correction round
(`ContractError` → run `ERRORED`), although the other criteria were fine.

## 2. Goal and success criteria

A short or vague requirement produces a real test of the feature the user meant, and the platform says what it
assumed. Measured on the requirement-compiler eval and the 12-case `evals/e2e-unclear` corpus:

- feature-level and vague requirements with pages read yield at least 2 structured (non-`semantic`) criteria;
- "Test this website" with pages read yields at least 2 criteria, none of them "the site loads";
- specific requirements yield **zero** inferred criteria (all existing eval cases keep passing unchanged);
- no inferred criterion without a `FOUND` site check survives; none describes a destructive action;
- an answer with one invalid criterion no longer errors the run.

## 3. Decisions

1. **Inferred criteria count toward the verdict** (`critical: true` like every criterion). They are what "works"
   means for a vague requirement. The user can untick or remove any of them in review.
2. **No extra model call.** Intent, inferred criteria and resolved ambiguity come from the existing compile call.
3. **Grounding is enforced by code**, not left to the prompt (section 5.3).
4. **Safety rules are untouched:** destructive-action blocking, host allowlist, the planner's blocking, deterministic
   verification, the verbatim `sourceText` rule.
5. **Nothing changes for a precise requirement.**

## 4. Contract changes (`packages/contracts/src/requirement.ts`)

All new fields are optional or defaulted, so stored revisions, saved tests, suites and scripted test answers parse
unchanged. No database migration: criteria live in a JSON column validated by this schema.

```ts
// AcceptanceCriterionSchema, added:
// All three optional (absent = stated, no rationale, no assumption), so every existing criterion literal and
// stored revision keeps its exact shape; `isInferred(c)` reads the origin.
origin: z.enum(["stated", "inferred"]).optional(),
/** Why the platform added an inferred criterion, in one sentence. Absent or null for a stated one. */
rationale: z.string().min(3).max(300).nullable().optional(),
/** A vague phrase checked in a concrete way: what the platform assumed it means. */
assumption: z.string().min(3).max(300).nullable().optional(),

// NormalizedRequirementSchema, added:
intent: z.object({
  clarity: z.enum(["specific", "feature", "vague", "site_wide"]),
  /** One sentence: what the user wants to know. */
  goal: z.string().min(3).max(300),
  /** The feature under test as the site names it ("Search", "Wishlist"), when there is one. */
  feature: z.string().min(1).max(80).nullable(),
  /** Things the analysis did on its own that are not tied to one criterion (e.g. a criterion it dropped). */
  notes: z.array(z.string().max(300)).max(10).default([]),
}).nullable().optional(),
```

Rules added to the schema's `superRefine`:

- an `inferred` criterion has a `rationale`; a `stated` one has none;
- `sourceText` stays a verbatim substring of `originalText` for **both** origins. For an inferred criterion it is
  the phrase being expanded (often the whole requirement), so every criterion still traces to the user's words;
- at most 5 inferred criteria.

## 5. Analysis (`packages/testing-engine/src/requirement`)

### 5.1 Model output (`model-output.ts`)

`CompilerOutputSchema` gains `intent` (`clarity`, `goal`, `feature`; defaulted to null so an answer without it
parses) and, per criterion, `origin`, `rationale` and `assumption` (all defaulted).

### 5.2 Prompt (`prompts.ts`)

Additions to `REQUIREMENT_SYSTEM_PROMPT`; the existing rules stay.

- **Intent.** Return `clarity`, a one-sentence `goal` and the `feature`. `specific`: the requirement names what to
  check. `feature`: it names a feature and says it should work. `vague`: quality words with no objective check.
  `site_wide`: no feature named.
- **Inferred criteria**, only when clarity is not `specific` **and** pages were provided: add up to 5 criteria with
  `origin: "inferred"` that a tester would run for this feature on this site: the main path with its visible
  result, and one negative path when it is safe and the pages show its control (wrong password → error, a search
  that matches nothing → empty state). Each needs a `rationale`, a `sourceText` copied from the requirement, and a
  `siteChecks` entry of status `found`. Never a destructive action, never a credential check, never wording or
  numbers the pages do not show as stable labels (the "never invent wording / numbers" rules apply unchanged).
- **A vague stated phrase is expanded, not duplicated.** When inferred criteria cover a phrase such as "works",
  do not also emit that phrase as a `semantic` criterion.
- **Resolve vague wording when the site allows.** When the pages show an objective way to check a vague phrase,
  emit the structured check and set `assumption` to what was assumed ("'shows the price' is checked as: a price is
  visible on the product page"); `ambiguity` is then null. `semantic` remains for look-and-feel only.
- **`site_wide`:** the inferred criteria cover the main features the pages show (navigation to a listing, search,
  product detail, cart), one each, most important first.

### 5.3 Deterministic validation (`post-validate.ts`, `insights.ts`)

New function `groundInferred(output, { pagesRead })`, applied before the existing rewrites. It drops an inferred
criterion, and records a note, when any of these holds:

| Rule | Check |
|---|---|
| The requirement is specific | `intent.clarity === "specific"` |
| No pages were read | `pagesRead === false` |
| Not grounded | its `siteChecks` entry is missing or not `found` |
| Destructive | `@platform/security`'s destructive-term matcher hits its statement |
| About credentials | it has a `secret` precondition the run does not have |
| Over the cap | it is the 6th or later inferred criterion |

Dropping re-numbers criteria, remaps `siteChecks` positions and removes facts no remaining criterion reads (the
logic `replaceUnstatedThresholds` already uses). If dropping would leave no criteria, the inferred ones are kept
out and the fallback of 5.4 applies. A criterion the model marks `stated` is never dropped by this function: the
model's `origin` can only lower a criterion's standing, never raise it. A missing `intent` is treated as
`specific` (no inferred criteria), so an answer from a model that ignores the new fields behaves as today.

The existing rewrites then run unchanged on what is left (`replaceUnstatedThresholds`, `replaceUnstatedTexts`), so
an inferred criterion with made-up wording becomes a `visible` check exactly like a stated one (KI-070).

### 5.4 Degrade instead of erroring (`compiler.ts`)

Today `generateStructured` runs `check` → one correction round → `ContractError`. New behaviour:

1. `check` first runs `groundInferred`, so an invalid **inferred** criterion never costs the correction round.
2. If the corrected answer still fails post-validation, `salvage(output, issues)` drops each criterion an issue
   points at (`criteria.<i>.…`), and facts only they read, then validates again. Each dropped criterion becomes an
   `intent.notes` entry: "Left out: <statement> (could not be turned into a check)".
3. If nothing valid is left, the draft is one `semantic` criterion whose `sourceText` and description are the whole
   requirement, `origin: "stated"`, with the note "The requirement could not be split into checks; it is judged as
   a whole from what the pages show". The existing judge step handles it.
4. `ContractError` remains only for an answer that is not JSON or does not match the output schema at all after
   the correction round.

The model client needs no change: `generateStructured`'s `check` already receives `context.corrected` (true for
the last answer the client asks for), so the compiler's `check` returns no issues for a corrected answer and the
compiler salvages it afterwards. The planner, judge, survey and input generator are unaffected.

### 5.5 What the draft carries

`RequirementDraft` gains `intent`. The orchestrator persists it with revision 1; `requirement.analyzed` events are
unchanged (criteria count only).

## 6. Planner (`planner/prompts.ts`)

`buildPlannerPrompt` adds one line after the requirement block when `intent` is present:
`What the user wants to know: <goal>` and, with a feature, `Feature under test: <feature>`. The system prompt gets
one sentence: plan the path a visitor would take to use that feature. The criteria JSON sent to the planner gains
`origin`. No change to plan validation or blocking.

## 7. API (`apps/api`)

- `criteria-edit.ts`: `origin`, `rationale` and `assumption` cannot be changed by a PUT (rejected like
  `sourceText`). Editing a criterion's check clears `assumption` with `ambiguity`, since the check is now the
  user's. Removing an inferred criterion works like removing any criterion. `intent` is copied from the latest
  revision, never from the body.
- A suggestion chosen from a survey, a rerun and a suite run copy criteria as today; the new fields travel with
  them.

## 8. Web (`apps/web`)

- **Criteria review** (`CriteriaReview.tsx`, `CriterionCard.tsx`): a "What I understood" line above the list shows
  `intent.goal`. Stated criteria come first, then a group headed "Added by the platform" where each card shows
  its `rationale` and the existing remove action. A criterion with an `assumption` shows it as a note
  ("Assumed: …"). `intent.notes` are listed under the group.
- **Report** (`RunReport.tsx`, `PrintableReport.tsx`, `CriteriaResults.tsx`): an "Assumptions" section lists the
  inferred criteria with their rationale, the per-criterion assumptions and the notes; each inferred result row
  carries an "Added by the platform" badge. When every critical criterion that decided a `PASSED` verdict is
  inferred, the verdict reads "Passed (on assumed checks)". The verdict value itself is unchanged.
- **Markdown report** (`reporting/markdown.ts`): the same section and badge text. JUnit output is unchanged.

## 9. Testing

Unit (TDD, written first):

- contracts: defaults parse old data; the three schema rules of section 4;
- `groundInferred`: one test per row of the table in 5.3, the renumbering of site checks, fact cleanup;
- `salvage`: one bad criterion dropped with its note; all bad → the whole-requirement fallback;
- `compileRequirement`: the corrected-but-still-invalid answer returns a salvaged draft instead of throwing;
- model client: `onCheckFailure: "return"`;
- planner prompt: goal and feature lines present only with an intent;
- `applyCriteriaEdit`: the new fields are immutable; a check edit clears `assumption`;
- web: review grouping, rationale, assumption note; report section, badge and verdict wording; Markdown.

Evals (cases added to `evals/requirement-compiler/cases`, with pages from the frontends-demo corpus):

| Case | Expectation |
|---|---|
| "Test the search" | ≥ 2 criteria, ≥ 1 inferred, all structured, no invented text |
| "Make sure login works" | an inferred rejected-login criterion checked with `visible` |
| "Test this website" | ≥ 2 inferred criteria, none semantic |
| "The product page should look good and show the price" | "show the price" structured with an `assumption`; "look good" semantic |
| A specific requirement (existing case 32) | 0 inferred |
| "Test the search" **without** pages | 0 inferred |

The eval suite gains `maxInferred`, `minInferred` and `forbidSemanticOnly` expectations. The planner eval is
re-run unchanged (its prompt gains two lines).

Both evals call a real model. They are written and run in fake mode where possible; **scoring on a paid model is
not part of this work unless the owner asks for it**, and until then `evals/BASELINE.md` records the prompts as
changed and not re-scored (a new known issue, like KI-026).

Existing suites must stay green: `pnpm typecheck`, `pnpm test`, and, with the local infra up,
`pnpm test:integration` and `pnpm test:e2e` (scripted answers have no intent and no inferred criteria, so they
exercise the default path).

## 10. Out of scope

- Goal steps, multi-hop recovery, replanning, keeping independent criteria alive (the exploration piece).
- Running the top suggestions automatically for a blank requirement.
- Choosing which pages the analysis reads from the intent (link ranking, larger discovery budget).
- A user-facing switch to turn inferred criteria off globally; removing them in review covers it for now.

## 11. Risks

| Risk | Mitigation |
|---|---|
| Noisy or wrong inferred checks cause false FAILs | grounded in `found` site checks, wording and numbers never invented (existing rewrites), cap of 5, shown and removable in review, labelled in the report |
| Auto-confirmed runs get inferred checks nobody reviewed | the report's Assumptions section and verdict wording; the eval cases |
| Prompt regression on precise requirements | all 35 existing compiler cases must pass unchanged before the new ones count |
| The salvage path hides a broken model | each drop is a visible note; a metric counts salvaged analyses |
