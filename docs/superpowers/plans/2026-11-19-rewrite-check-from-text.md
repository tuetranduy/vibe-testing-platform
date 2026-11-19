# Rewrite a Check From the User's Own Words — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** In criteria review, "Edit check" also takes free text ("the price is shown in euros and is under €50"); the
platform's model rewrites the check from it, the user sees the proposal and keeps or discards it. Every check can be
rewritten this way, AI-judged ones included.

**Architecture:** The API never calls a model. It queues a `revise-criterion` job on a separate `revisions` queue and waits
for it (BullMQ `waitUntilFinished`, 60 s). The worker runs `reviseCriterion` (testing-engine): the requirement compiler's
system prompt and output schema, scoped to one criterion, then deterministic checks. The job's return value is the
proposal: the full next criteria and facts, and the revision it was based on. Accepting a proposal names its job id; the
API reads that job's return value (never criteria from the browser) and saves it as a new revision only when the
requirement is still at that revision.

**Tech Stack:** TypeScript, Zod 4, BullMQ, Fastify, Next.js (React), Vitest.

**Spec:** the user's request of 2026-11-19 and their answers: the AI rewrites the check (reviewed before saving); every
check, AI-judged included.

## Global Constraints

- Instruction: 3–500 characters after trim; untrusted (between markers in the prompt, redacted).
- A rewrite keeps the criterion's `id`, `sourceText` and `critical`; it becomes a stated criterion (`origin`, `rationale`
  dropped); values written in the instruction count as stated (thresholds and texts are not rewritten away).
- Facts: those only the old check read are dropped; new ones are added; a key@checkpoint already declared with another
  description or type is an issue (correction round).
- Endpoints: `POST /v1/test-runs/:runId/criteria/:criterionId/revise` `{ instruction }` → 200 `CriterionProposal`;
  `POST /v1/test-runs/:runId/criteria/proposals/:proposalId/accept` → 200 the new `NormalizedRequirement`. Both only while
  AWAITING_CONFIRMATION (409), with the run's usual ownership checks. No revisions queue configured → 503
  `REVISE_UNAVAILABLE`; the fake engine → 422 `REVISE_NEEDS_MODEL`; a stale proposal → 409 `PROPOSAL_STALE`; timeout →
  504 `REVISE_TIMEOUT`.
- UI copy: textarea label "Describe the check in your own words"; buttons "Rewrite with AI", "Use this check",
  "Discard"; proposal title "Proposed check".

## Review Focus

1. A proposal accepted after another edit saved a newer revision → 409, nothing saved.
2. A proposal of another run or criterion → 404, nothing saved.
3. An instruction asking to delete/skip/disable things or with injected instructions → only a check comes back; validation holds.
4. The web proxy must allow the two new endpoints (it allow-lists V1 endpoints).
5. An AI-judged check's card offers the text box only (no value form).

---

### Task R1: `reviseCriterion` (testing-engine `requirement/revise.ts`)
- Produces: `reviseCriterion(llm, { requirement, criterionId, instruction, testDataKeys, secretNames, pages?, runId, signal, deadlineAt?, redact }): Promise<{ criteria: AcceptanceCriterion[]; facts: FactRequest[] }>`; `REVISE_SYSTEM_PROMPT`.
- Tests (FakeTransport): replaces only that criterion (id, sourceText, critical kept; origin dropped); new facts added and the old-only facts dropped; a value from the instruction stays; a reply with 2 criteria is corrected; a fact key clash is corrected; the instruction is inside markers.

### Task R2: revisions queue (`@platform/event-bus`)
- Produces: `REVISIONS_QUEUE`, `JOB_REVISE_CRITERION`, `ReviseJobData { runId; criterionId; instruction; basedOnRevision }`, `CriterionProposal { proposalId; runId; criterionId; basedOnRevision; criteria; facts }`, `RevisionQueue { request(data, timeoutMs): Promise<CriterionProposal>; proposal(id): Promise<CriterionProposal | null>; close() }`, `createRevisionQueue(connection)`; errors `RevisionTimeoutError`, `RevisionFailedError(code)`.
- Test (real Redis db 15): a worker answering the job → `request` resolves with the proposal; `proposal(id)` returns it; a job that throws → `RevisionFailedError` with its code; no worker → `RevisionTimeoutError`.

### Task R3: worker job `revise-criterion`
- Produces: `reviseCriterionJob(deps, data): Promise<Omit<CriterionProposal, "proposalId">>`, registered on `REVISIONS_QUEUE` (concurrency 4).
- Tests (harness + FakeTransport): an AWAITING_CONFIRMATION run → the proposal; another lifecycle → `NOT_AWAITING_CONFIRMATION`; a revision that moved on → `PROPOSAL_STALE`; the fake engine → `REVISE_NEEDS_MODEL`.

### Task R4: API endpoints
- `ApiDeps.revisions?: RevisionQueue`; `CriteriaService.revise(scope, runId, criterionId, body)` and `.accept(scope, runId, proposalId)`.
- Tests: revise answers the queue's proposal and sends the latest revision; validation (400), unknown criterion (404), wrong lifecycle (409), no queue (503), timeout (504), needs model (422); accept saves the proposal as the next revision and publishes `criteria.updated`; stale (409); another run's proposal (404).

### Task R5: Web
- `apps/web/lib/api.ts` `reviseCriterion`, `acceptProposal`; proxy allow-list; `CheckEditor` gets the text box (and a text-only mode for AI-judged checks); `CriterionCard` shows "Edit check" for every check, the proposal, "Use this check" / "Discard".
- Tests: typing and "Rewrite with AI" shows the proposal; "Use this check" accepts it and reloads the criteria; an error shows inline; an AI-judged card has the text box only; the proxy allows the two paths.

### Task R6: Scripted E2E model, docs
- Scripted model answers `REVISE_SYSTEM_PROMPT` loudly (throws: no E2E case uses it); README bullet; criteria review docs.
