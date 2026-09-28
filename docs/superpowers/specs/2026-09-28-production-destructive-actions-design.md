# Destructive actions on production — design

**Date:** 2026-09-28 · **Status:** approved design (approach 1: one flag + typed host confirmation) · **Amends:** plan
decision D9 ("Always blocked when `environment = production`").

## Problem

Destructive actions — creating, changing or deleting data, placing orders, paying (the destructive term list in
`packages/security/src/action-policy.ts` plus the planner's `destructive` flag) — are blocked in production with no
way to allow them. Four places enforce it: the create-run contract (`packages/contracts/src/run.ts`, "never allowed in
production"), the planner's `actionPolicyFor` (`packages/testing-engine/src/planner/planner.ts`), the executor's own
copy of that expression (`packages/testing-engine/src/exploration/executor.ts`), and the new-test form. A team whose
only environment is production, or that needs to test create/edit/delete flows there, cannot test them at all.

Three related defects surfaced while designing this; they already affect `allowDestructiveActions` on staging:

1. Stagehand's system prompt always says "Do not perform destructive actions." (`packages/stagehand-adapter/src/guardrails.ts`),
   even when the run allows them, so the model may refuse to locate the element a permitted destructive step needs.
2. The Playwright rerun replays the discovered flow from the start (D2), so every destructive action runs **twice**:
   once while exploring and again in the rerun. A delete then fails the rerun (`DISCOVERY_RERUN_DISAGREE`), a create
   makes a duplicate, a payment charges twice.
3. Once destructive actions are allowed, the executor's element check (`enforcePolicy`) lets any destructive element
   through — including one a prompt-injected page steers the model to while executing a harmless step.

## Goal and success criteria

- A production run can perform destructive actions — with exactly the meaning `allowDestructiveActions` has on
  staging, money movement included — when, and only when, the request sets `allowDestructiveActions` **and** confirms
  the target host.
- The API enforces the host confirmation for every client: a staging request body copied to production with only
  `environment` changed is rejected.
- Defaults are unchanged: destructive actions stay blocked unless a run allows them, in both environments.
- In a run that allows destructive actions, a destructive element is acted on only by a planned step that is itself
  destructive.
- A run that allows destructive actions does not repeat them in the rerun unless the user asks for it.
- Runs that allow destructive actions are visibly marked; production ones prominently.

## Non-goals

- An operator-level switch (environment variable): the UI is used by a trusted team only (decision 2026-09-28).
- A separate category for money movement: allowed together with everything else (decision 2026-09-28).
- A report section listing the destructive actions performed (derivable later from recorded steps'
  `plannedStepId` → planned step `destructive`, with no schema change).
- Changing what counts as destructive (the term list and the planner prompt's definition stay as they are).
- Showing the plan's steps before execution (criteria review stays as it is).

## Design

### 1. Contract — `packages/contracts/src/run.ts`

- `RunOptionsSchema` gains `confirmProductionHost: z.string().trim().min(1).max(255).optional()`.
- The refine "Destructive actions are never allowed in production" is replaced by two rules, both reported at
  `["options", "confirmProductionHost"]`:
  - `environment = "production"` and `allowDestructiveActions` → `confirmProductionHost`, lowercased, must equal
    `new URL(targetUrl).host` (the URL parser lowercases it; it includes a non-default port, e.g. `localhost:4000`).
    Message: ``Type the website's host (`<host>`) to allow destructive actions in production``.
  - `confirmProductionHost` present in any other case → "Only used when destructive actions are allowed in
    production". (Stored requests stay unambiguous.)
- **Rerun default follows the flag.** `rerunGeneratedTest` has no fixed default any more: when the request omits it,
  it is `!allowDestructiveActions`. An explicit value always wins, so a client can still ask for the rerun. The
  existing rule "rerunGeneratedTest requires generatePlaywright" is unchanged.
- A pure helper, exported from the package: `destructiveActionsAllowed(request)` → `options.allowDestructiveActions
  && (environment !== "production" || confirmProductionHost matches the target host)`. The refine uses the same host
  comparison; the engine and the run summary use the helper (section 2, 5), so a stored request that somehow lacks
  the confirmation is still denied (defense in depth).

`POST /v1/test-runs` needs no code change: it already parses with this schema and answers `400 VALIDATION_FAILED`
with per-field `issues`, which the new-test form maps onto its fields.

### 2. One policy for planner and executor — `packages/testing-engine`

- `actionPolicyFor(request)` returns `{ allowDestructive: destructiveActionsAllowed(request) }`. It moves to
  `src/shared/action-policy.ts`; the planner and the executor both call it (the executor's constructor stops
  computing its own expression). The planner re-exports it for existing importers.
- `planner/blocking.ts`: the "not authorized" detail becomes "destructive actions are not allowed for this run
  (allowDestructiveActions is off)" — production without a confirmed host can no longer reach the engine.

### 3. Destructive elements only on destructive steps — `exploration/executor.ts`

`enforcePolicy` checks the element the step resolved to (instruction, element role/name/text) as today. New rule when
the run allows destructive actions: if the element matches a destructive term but the planned step is not
destructive (`step.destructive`, which `applyBlocking` already sets from the planner's flag **or** a term match on
the step's description), the step is `BLOCKED_BY_POLICY` / `DESTRUCTIVE_ACTION_NOT_AUTHORIZED` with the error
"The element is destructive but the planned step is not". Without allowed destructive actions, behaviour is
unchanged (every destructive element or flagged step is blocked).

### 4. Stagehand guardrail per run — `packages/stagehand-adapter`

- `guardrails.ts` exports `guardrailSystemPrompt({ allowDestructive })`. `false` gives today's text unchanged
  (`GUARDRAIL_SYSTEM_PROMPT` stays as that variant); `true` replaces the last line with "- Perform a destructive
  action (delete, pay, place an order, …) only when the current planned step asks for it."
- `ExplorerStartInput` gains a required `allowDestructive: boolean` (required, like `redact`: no fail-open default).
  `StagehandExplorer.start` passes the matching prompt as `systemPrompt`. The explore stage passes
  `actionPolicyFor(ctx.request).allowDestructive`. The E2E `ScriptedExplorer` accepts and ignores it.
- The prompt remains defense in depth only; the executor (section 3) and the planner's blocking decide.

### 5. Run summary — `TestRunSummarySchema` and `toRunSummary`

`TestRunSummary` gains `environment: "staging" | "production"` and `allowDestructiveActions: boolean` — the effective
value, `destructiveActionsAllowed(run.request)`. `toRunSummary` (`packages/db/src/run-repository.ts`) fills both;
`GET /v1/test-runs` and `GET /v1/test-runs/:runId` return them.

### 6. Web UI — `apps/web`

**New-test form** (`components/NewTestForm.tsx`):

- The checkbox reads "Allow destructive actions (create, change or delete data, place orders, pay)" and is enabled
  in both environments; the body sends `allowDestructiveActions` as ticked (no staging-only guard any more).
- **Rerun coupling.** Ticking it also unticks "Rerun the generated test" and shows, under the checkbox: "Rerun is
  off: it repeats the whole test, so destructive actions would run a second time. You can turn it back on."
  Re-ticking the rerun while destructive actions are allowed turns that note into a warning: "Destructive actions
  will run twice: once while exploring and again in the rerun." Unticking "Allow destructive actions" restores the
  rerun setting it had before.
- **Production confirmation.** With Production selected and the box ticked, a danger panel appears under it: "This
  run can create, change or delete real data and place real orders or payments on `<host>`. Type `<host>` to
  confirm.", with a text input (`id="options-confirmProductionHost"`, autocomplete and spellcheck off). Before the
  URL is valid the panel says "Enter the website URL first." The field is validated on submit like the rest of the
  form: a missing or different host sets the field error "Type `<host>` exactly to confirm.", opens Advanced options
  and focuses the field; no request is sent. The body carries `confirmProductionHost` only for production with the
  box ticked. A server issue on that path lands on the same field (`issuesToErrors` already maps `options.*`).
- Environment hint (both environments): "Destructive actions are blocked unless you allow them under Advanced
  options." The Advanced options summary shows "destructive allowed" whenever the box is ticked.

**Run page** (`components/RunView.tsx`): in `.run-meta`, a chip when `summary.allowDestructiveActions` —
"Production · destructive actions allowed" (danger style) for production, "Destructive actions allowed" (warning
style) for staging.

**History** (`components/RunHistory.tsx`): production runs with destructive actions allowed get a
"Production · destructive" tag after the host.

### 7. Unchanged

Criteria review and confirmation (D5), the report, the verifier, reconciliation, the compiler and the rerun itself.
A run without a rerun is reported as today ("Not confirmed by rerun"; PASS/FAIL stand only on DOM-verified facts, D2).

## Testing

- **Contracts:** production + destructive without a host, with a wrong host, with a matching host (different case;
  with a port) → issue / issue / ok; the host present when not needed (staging; production without destructive) →
  issue; `destructiveActionsAllowed` truth table; `rerunGeneratedTest` omitted → `!allowDestructiveActions`, explicit
  `true` kept with destructive allowed.
- **Engine:** `actionPolicyFor` table (production + confirmed host → allowed; production + allowed but no host, built
  bypassing the contract → denied); the existing "production blocks destructive steps even when
  allowDestructiveActions is on" test becomes "…without a confirmed host", plus "production with a confirmed host
  plans the destructive step unblocked"; executor: clicks a destructive element on a destructive step in production
  with a confirmed host; blocks a destructive element on a non-destructive step when destructive actions are allowed
  (the KI-006 "danger zone" shape), and still blocks both when they are not; the new blocking detail text.
- **Stagehand adapter:** both prompt variants (the existing exact-text test is the `false` variant); `start` passes
  the variant matching `allowDestructive`.
- **DB / API:** `toRunSummary` includes both fields (effective value); `POST /v1/test-runs` production + destructive
  without the host → 400 with the issue path, with it → 202; `GET` summaries include the fields.
- **Web:** checkbox enabled in production; rerun unticked on tick, restored on untick, twice-warning when re-ticked;
  danger panel text with the host and the no-URL variant; submit with empty / wrong host → field error, focus,
  Advanced options open, no request; matching host → body has `confirmProductionHost`; staging never sends it; the
  run-page chip (production / staging / none) and the history tag; fixtures gain the summary fields.
- **E2E** (`tests/e2e/platform-destructive.spec.ts`): new case — production, `allowDestructiveActions`,
  `confirmProductionHost` = the demo shop's host, rerun left at its default → `COMPLETED`, no criterion
  `BLOCKED / DESTRUCTIVE_ACTION_NOT_AUTHORIZED`, exactly one delete click (the rerun did not repeat it); the
  "danger zone" scenario (a neutral step that resolves to "Delete account") with the same production options → still
  `BLOCKED / DESTRUCTIVE_ACTION_NOT_AUTHORIZED`, zero delete clicks (section 3); and a production + destructive request
  without the host → `400`. The two new run cases are CI mode only (the scripted plan decides the steps); the
  existing blocked-by-default cases stay as they are in both modes.
- **Suites:** contracts, security, testing-engine, stagehand-adapter, db, api, worker and web green; root typecheck;
  `pnpm test:e2e`.

## Docs

- README "Deviations from the plan": D9 amended — destructive actions are blocked by default; in production they
  are allowed only with a per-run confirmation of the target host; runs that allow them skip the rerun unless asked;
  a destructive element is acted on only by a step the plan marks destructive.
- The plan file stays read-only (as for KI-015); the README records the deviation.

## Risks

- Destructive actions on production cannot be undone by the platform. Mitigations: per-run typed host, the rerun off
  by default, destructive elements only on destructive steps, visible marking. Residual: the plan is not shown before
  execution, so a user who confirms criteria does not see every step the planner will take.
- Relaxing the Stagehand prompt for allowed runs makes the model more willing to act on destructive elements. The
  executor's rule in section 3 keeps that from reaching a non-destructive step.
- Section 3 may block a legitimate confirmation click whose planned step is worded neutrally (e.g. "Click Yes" on a
  "Delete?" dialog). The planner prompt already asks for such steps to be marked destructive; the block is reported
  with its reason, and being conservative in production is intended.
- API clients relying on `rerunGeneratedTest` defaulting to `true` with destructive actions allowed now get no rerun.
  Only the web UI and the E2E suite call the API (D6), and both change in the same branch.
