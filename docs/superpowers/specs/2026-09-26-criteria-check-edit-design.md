# Criteria review: edit the check, not the wording — design

**Date:** 2026-09-26 · **Status:** approved design (approach A) · **Supersedes:** Ruling R55 (Milestone D) and the "statement text" edit allowed by plan Task 11, Step 1.

## Problem

During criteria review (`AWAITING_CONFIRMATION`, D5) a user can change a criterion's `statement`, but the verifier judges `criterion.expectedOutcome` (`packages/testing-engine/src/verification/verifier.ts`). Rewording "1 item" to "2 items" leaves the check asserting 1, so the report shows a PASS next to wording that says 2. Milestone D only discloses the mismatch (R55); nothing prevents it.

## Goal and success criteria

- A confirmed criterion's `statement` always describes the check that is actually run.
- Users can still correct the common mistakes on the spot: a wrong number, operator, text or match mode, expected visibility, or a criterion that should not exist.
- Anything the structured editor cannot express is handled by starting over with a revised requirement.
- The API enforces the rules for every client, not only the web UI.
- No model call, no new lifecycle transition, no new endpoint; D5 unchanged.
- The user's example is a regression test: editing "1 item" → "2 items" produces a check that asserts 2.

## Non-goals

- Re-deriving a check with the model from reworded text (approach B; can be added later on top of this).
- Adding criteria, changing which fact/element/moment a check reads, or turning an AI-judged (`semantic`) criterion into a structured one.
- Carrying test data and secrets over when starting over (secrets are never re-sent by design).

## Design

### 1. API rules — `PUT /v1/test-runs/:runId/criteria`

`CriteriaService.update` (apps/api/src/services/criteria-service.ts) keeps its current order — tenant lookup, `NormalizedRequirementSchema` parse, `originalText` unchanged, `RequirementRepository.createRevision` (lifecycle/frozen guards → 409) — and adds a comparison against the latest revision **before** saving. The comparison is a pure helper in the API (`apps/api/src/services/criteria-edit.ts`), unit-tested on its own:

| Change in the body vs the latest revision | Result |
|---|---|
| A criterion is missing (removed) | allowed (the schema still requires ≥ 1 criterion) |
| A criterion `id` not in the latest revision (added) | 400 |
| `sourceText` or `preconditions` of a criterion changed | 400 |
| A fact added, or an existing fact's `description`/`valueType` changed | 400 (dropping facts that no remaining criterion references is allowed; the schema still rejects dropping a referenced one) |
| `expectedOutcome.kind` changed | 400 |
| Any fact reference inside `expectedOutcome` changed (key or checkpoint) | 400 |
| An editable parameter changed (table below) | allowed → **edited criterion** |
| `statement` changed while the check is unchanged | 400 `STATEMENT_ONLY_EDIT` |
| `ambiguity` changed on an unedited criterion | 400 |
| An edited `text_matches` check in `regex` mode whose pattern does not compile (`new RegExp`) | 400 |

Editable parameters (same kind only):

| Kind | Editable | Fixed |
|---|---|---|
| `visible` | `expected` | `fact` |
| `text_matches` | `match.mode`, `match.value`, `match.caseSensitive` | `fact` |
| `numeric_compare` | `operator`; `right` when it is a number (stays a number) | `left`; `right` when it is a fact reference |
| `numeric_delta` | `delta` | `before`, `after` |
| `collection_contains` | `match`; `item` when it is a string (stays a string) | `collection`; `item` when it is a fact reference |
| `semantic` | nothing (can only be removed) | `description` |

For every **edited criterion** the server:

- writes `statement = describeExpectedOutcome(expectedOutcome, facts)` (section 2), ignoring the `statement` sent by the client;
- sets `ambiguity = null` (the user has made the check explicit).

Unedited criteria are saved exactly as in the latest revision.

Errors use the existing 400 shape `{ code: "VALIDATION_FAILED", message, issues: [{ path, message }] }` (apps/api/src/errors.ts); the statement-only case uses `code: "STATEMENT_ONLY_EDIT"` so the UI can explain it. Paths point at the offending field (e.g. `["criteria", 1, "expectedOutcome", "left"]`). The `criteria.updated` event and the response (the saved revision) are unchanged.

### 2. Shared wording — `packages/contracts`

A pure function `describeExpectedOutcome(outcome: ExpectedOutcome, facts: readonly FactRequest[]): string` in `packages/contracts/src/describe-outcome.ts`, exported from the package index, next to `factRefsOf`:

- One plain sentence per kind, naming facts by their `FactRequest.description` (fallback: "The page address" for `url`, else the key) and the checkpoint in words. It is the existing web helper `apps/web/components/outcome-text.ts` (Milestone D, R55) moved into contracts, with its wording kept.
- `semantic` → "Judged by AI only, so it ends Inconclusive: “…”." (used for display only; semantic criteria are never edited).
- Output is clipped to the statement limit (1000 characters) with an ellipsis, so a generated statement always passes `AcceptanceCriterionSchema`.

The web imports it from `@platform/contracts`; `outcome-text.ts` and its test move to contracts (the web keeps no copy).

### 3. Web UI

`CriterionCard` (apps/web/components/CriterionCard.tsx):

- Shows the statement, "What will be checked" (`describeExpectedOutcome`), the source quote, ambiguity reason/suggestions as today.
- Replaces the free-text statement editor with **Edit check**: an inline form with only the editable parameters of the check's kind — operator select, number input, text input, match-mode select, case-sensitive checkbox, visible/not-visible choice, item text — with labels in plain language. A live preview shows the statement the server will write. Save sends the full requirement with the edited `expectedOutcome` (and the preview as `statement`); Discard closes the form.
- Client-side validation mirrors the contract (e.g. number is finite, text 1–500 characters) before sending; server 400 `issues` are shown inline on the form.
- Semantic criteria show "Judged by AI only — it can only be removed." and no Edit check button.
- Remove keeps its confirmation.
- The R55 "rewording changes the description only" note is removed.

`CriteriaReview` keeps the Milestone D guard: Confirm is disabled while any check editor is open, with the visible explanation.

**Start over with a revised requirement** — a secondary action on the review screen:

1. Asks for confirmation ("This cancels the current run. You can edit the requirement and start a new one. Test data and secrets must be entered again.").
2. `POST …/cancel`, then navigates to `/runs/new?from=<runId>`.
3. `NewTestForm` with `from` loads the run summary (`targetUrl`) and `GET …/criteria` (`originalText`) through the proxy and pre-fills the URL and requirement fields; a note says test data and secrets must be re-entered. If loading fails, the form stays empty with a short notice. No new endpoint.

### 4. Unchanged

The testing engine (planner, explorer, verifier, compiler, reconciliation), the worker, the report, and confirm (`POST …/confirm`, warnings) need no code change: they read the confirmed revision, whose statement now matches its check. `semantic` and still-ambiguous criteria keep producing the Inconclusive warning on confirm.

## Testing

- **Contracts:** `describeExpectedOutcome` — one test per kind, unknown fact description fallback, the `url` fact, clipping at 1000 characters.
- **API (TDD, `criteria-edit.test.ts` + `test-run-criteria.test.ts`):** each allowed edit per kind; each rejected change in the table above; server-written statement and `ambiguity: null` for edited criteria; unedited criteria byte-for-byte unchanged; the "1 item" → "2 items" regression (numeric_compare right 1 → 2 gives a statement and check that both say 2); existing Task 11 tests updated where they edited `statement` alone (they now expect 400 `STATEMENT_ONLY_EDIT`).
- **Web:** Edit check form per kind; preview text; PUT body; 400 `issues` shown inline; semantic cards have no editor; Confirm guard with an open check editor; Start over (confirm → cancel request → navigation with `from`) and the pre-filled form (URL + requirement, empty test data/secrets, notice), including the load-failure path.
- **Suites:** api, contracts, testing-engine, worker and web green; root typecheck.

## Docs

- README: criteria review section (edit the check; start over for anything else) and a deviation note superseding R55 and the Task 11 "statement text" edit.
- Plan Task 11: a one-line pointer to this spec.

## Risks

- Generated statements are plainer than model-written ones. Acceptable: correctness over style, and only edited criteria are affected.
- API clients that edited `statement` alone now get 400. Only the web UI calls the API (D6), and it changes in the same branch.
