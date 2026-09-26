# Criteria Review: Edit the Check, Not the Wording — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** During criteria review a user edits a criterion's *check* (its literal values) instead of its wording; the server writes the wording from the check, so a confirmed criterion's statement always describes what is actually verified.

**Architecture:** A pure `describeExpectedOutcome` in `@platform/contracts` turns a check into one sentence (shared by API and web). The API's `PUT …/criteria` compares the body with the latest revision through a pure helper (`applyCriteriaEdit`) that allows removals and edits of a check's literal values, rejects everything else, and rewrites `statement` / clears `ambiguity` for edited criteria. The web replaces the free-text statement editor with a structured "Edit check" form and adds "Start over with a revised requirement" (cancel + pre-filled new-test form).

**Tech Stack:** TypeScript, Zod 4 (`@platform/contracts`), Fastify (apps/api, tests with `app.inject` against real Postgres), Next.js 16 / React 19 (apps/web, Vitest + jsdom + Testing Library), pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-09-26-criteria-check-edit-design.md` — read it before any task.

## Global Constraints

- No model call, no new lifecycle transition, no new API endpoint; D5 unchanged (criteria editable only in `AWAITING_CONFIRMATION`; confirmation freezes them).
- All request bodies are still parsed with `NormalizedRequirementSchema` first; errors use the existing shape `{ code, message, issues?: [{ path, message }] }` (apps/api/src/errors.ts, `HttpError`).
- New error codes: `VALIDATION_FAILED` (rule violations, 400) and `STATEMENT_ONLY_EDIT` (400).
- A generated statement is clipped to 1000 characters (the `AcceptanceCriterionSchema.statement` limit) with a trailing `…`.
- Regex patterns are checked the way the verifier compiles them: `new RegExp(value, caseSensitive ? "" : "i")`, max 500 characters (`MAX_REGEX_LENGTH`).
- Run pnpm with `/opt/homebrew/bin` first on PATH (`export PATH=/opt/homebrew/bin:$PATH`); nvm's corepack pnpm is broken on this machine.
- Infrastructure (Postgres, Redis, S3) runs in docker compose; API/worker tests use Redis DB 15 by default. Never stop, restart or kill the user's `pnpm dev` processes or compose containers.
- TDD: write the failing test, watch it fail, implement, watch it pass.
- Every commit message ends with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never stage `Claude outputs/`.

## Review Focus

1. **Removing a criterion drops the facts only it used** — the save must succeed (facts may shrink, never grow or change). Pinned in Task 2 (`applyCriteriaEdit` "drops facts no remaining criterion reads").
2. **An edited regex that does not compile** (e.g. `(`) — must be rejected before it is saved, by the web form and by the API. Pinned in Task 2 and Task 3.
3. **An empty or non-numeric number field** (``, `abc`, `1e400`) — the form must refuse to save with an inline message; nothing is sent. Pinned in Task 3.
4. **Editing a criterion a second time** (its statement is already generated, ambiguity already null) — must be accepted and regenerate the statement again. Pinned in Task 2.
5. **"Start over" when the run can no longer be cancelled** (409: it already ended or the confirmation expired) — still go to the pre-filled form; any other failure shows an error and stays. Pinned in Task 4.

---

### Task 1: `describeExpectedOutcome` in contracts

Move the web-only wording helper (Milestone D, Ruling R55) into `@platform/contracts`, add clipping, and switch the web to it.

**Files:**
- Create: `packages/contracts/src/describe-outcome.ts`
- Create: `packages/contracts/src/describe-outcome.test.ts` (moved from `apps/web/components/outcome-text.test.ts`, plus clipping tests)
- Modify: `packages/contracts/src/index.ts` (export)
- Modify: `apps/web/components/CriterionCard.tsx` (import from contracts)
- Delete: `apps/web/components/outcome-text.ts`, `apps/web/components/outcome-text.test.ts`

**Interfaces:**
- Produces: `describeExpectedOutcome(outcome: ExpectedOutcome, facts: readonly FactRequest[]): string` and `STATEMENT_MAX_LENGTH = 1000`, exported from `@platform/contracts`.

- [ ] **Step 1: Move the test and add the clipping tests**

`git mv apps/web/components/outcome-text.test.ts packages/contracts/src/describe-outcome.test.ts`, then in the moved file replace the imports and the helper:

```ts
import { describe, expect, it } from "vitest";
import { describeExpectedOutcome, STATEMENT_MAX_LENGTH } from "./describe-outcome";
import type { ExpectedOutcome, FactRequest } from "./requirement";
```

Replace every `describeOutcome(` with `describeExpectedOutcome(` and the `describe("describeOutcome"` title with `describe("describeExpectedOutcome"`. Append inside the `describe` block:

```ts
  it("clips a generated sentence to the statement limit", () => {
    const long = "x".repeat(500);
    const wide: FactRequest[] = [{ key: "heading", checkpoint: "results", description: "d".repeat(500), valueType: "string" }];
    const out = describeExpectedOutcome(
      { kind: "text_matches", fact: at("heading", "results"), match: { mode: "equals", value: long, caseSensitive: false } },
      wide,
    );
    expect(out).toHaveLength(STATEMENT_MAX_LENGTH);
    expect(out.endsWith("…")).toBe(true);
  });

  it("leaves a short sentence unclipped", () => {
    expect(text({ kind: "visible", fact: at("banner", "home"), expected: true }).endsWith("…")).toBe(false);
  });
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @platform/contracts exec vitest run src/describe-outcome.test.ts`
Expected: FAIL — `Cannot find module './describe-outcome'`.

- [ ] **Step 3: Create `packages/contracts/src/describe-outcome.ts`**

```ts
import { URL_FACT_KEY, type FactRef } from "./common";
import type { ExpectedOutcome, FactRequest } from "./requirement";

/** `AcceptanceCriterionSchema.statement`'s limit: a generated statement always fits it. */
export const STATEMENT_MAX_LENGTH = 1000;

/**
 * What a criterion's check actually verifies, in one plain sentence. The API writes it as the
 * statement of every criterion whose check a user edited during review, and the web shows it as
 * "What will be checked" and as the edit preview — one wording for both, so a statement can never
 * describe a different check than the one the verifier runs. Facts are named by the
 * requirement's own descriptions where it has them.
 */
export function describeExpectedOutcome(outcome: ExpectedOutcome, facts: readonly FactRequest[]): string {
  return clip(sentence(outcome, facts));
}

function sentence(outcome: ExpectedOutcome, facts: readonly FactRequest[]): string {
  const fact = (ref: FactRef) => {
    const known = facts.find((f) => f.key === ref.key && f.checkpoint === ref.checkpoint)?.description;
    const name = known ?? (ref.key === URL_FACT_KEY ? "The page address" : ref.key);
    return `${name} (at “${ref.checkpoint.replaceAll("_", " ")}”)`;
  };
  const quoted = (s: string) => `“${s}”`;

  switch (outcome.kind) {
    case "visible":
      return `${fact(outcome.fact)} is ${outcome.expected ? "visible" : "not visible"}.`;
    case "text_matches": {
      const { mode, value, caseSensitive } = outcome.match;
      const how = mode === "equals" ? "is exactly" : mode === "contains" ? "contains" : "matches the pattern";
      return `${fact(outcome.fact)} ${how} ${quoted(value)} (${caseSensitive ? "case-sensitive" : "ignoring case"}).`;
    }
    case "numeric_compare": {
      const right = typeof outcome.right === "number" ? String(outcome.right) : fact(outcome.right);
      return `${fact(outcome.left)} ${COMPARE[outcome.operator]} ${right}.`;
    }
    case "numeric_delta": {
      const { delta } = outcome;
      const by = delta === 0 ? "is the same as" : `is exactly ${Math.abs(delta)} ${delta > 0 ? "more" : "less"} than`;
      return `${fact(outcome.after)} ${by} ${fact(outcome.before)}.`;
    }
    case "collection_contains": {
      const item = typeof outcome.item === "string" ? quoted(outcome.item) : fact(outcome.item);
      return `${fact(outcome.collection)} include an item ${outcome.match === "equals" ? "that is exactly" : "containing"} ${item}.`;
    }
    case "semantic":
      return `Judged by AI only, so it ends Inconclusive: ${quoted(outcome.description)}.`;
  }
}

const clip = (s: string) => (s.length <= STATEMENT_MAX_LENGTH ? s : `${s.slice(0, STATEMENT_MAX_LENGTH - 1)}…`);

const COMPARE: Record<Extract<ExpectedOutcome, { kind: "numeric_compare" }>["operator"], string> = {
  eq: "equals",
  neq: "does not equal",
  gt: "is greater than",
  gte: "is at least",
  lt: "is less than",
  lte: "is at most",
};
```

Check `packages/contracts/src/common.ts` exports `URL_FACT_KEY` and `FactRef` (it does; `requirement.ts` imports them from there). Add to `packages/contracts/src/index.ts` after `export * from "./requirement";`:

```ts
export * from "./describe-outcome";
```

- [ ] **Step 4: Run the contracts tests**

Run: `pnpm --filter @platform/contracts test`
Expected: PASS (all, including the moved tests and the two clipping tests).

- [ ] **Step 5: Switch the web to the shared function**

In `apps/web/components/CriterionCard.tsx` replace `import { describeOutcome } from "./outcome-text";` with adding `describeExpectedOutcome` to the existing `@platform/contracts` import, and replace `describeOutcome(` with `describeExpectedOutcome(`. Then `git rm apps/web/components/outcome-text.ts` (the test was moved in Step 1). Search for any other importer: `grep -rn "outcome-text" apps/web --exclude-dir=node_modules --exclude-dir=.next` must print nothing.

- [ ] **Step 6: Run the web tests and typecheck**

Run: `pnpm --filter @platform/web test && pnpm --filter @platform/web typecheck && pnpm --filter @platform/contracts typecheck`
Expected: PASS, no output change in the "shows what each criterion actually checks" test.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/describe-outcome.ts packages/contracts/src/describe-outcome.test.ts packages/contracts/src/index.ts apps/web/components/CriterionCard.tsx apps/web/components/outcome-text.ts apps/web/components/outcome-text.test.ts
git commit -m "refactor: share the plain-language check description through contracts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: API — only a check's values can change; the server writes the wording

**Files:**
- Create: `apps/api/src/services/criteria-edit.ts`
- Create: `apps/api/src/services/criteria-edit.test.ts`
- Modify: `apps/api/src/services/criteria-service.ts` (`update`)
- Modify: `apps/api/src/routes/test-run-criteria.test.ts`

**Interfaces:**
- Consumes: `describeExpectedOutcome(outcome, facts)` from `@platform/contracts` (Task 1).
- Produces: `applyCriteriaEdit(latest: NormalizedRequirement, body: Pick<NormalizedRequirement, "criteria" | "facts">): EditResult` where
  `EditResult = { ok: true; criteria: AcceptanceCriterion[]; facts: FactRequest[] } | { ok: false; code: "VALIDATION_FAILED" | "STATEMENT_ONLY_EDIT"; issues: { path: (string | number)[]; message: string }[] }`.
  HTTP: `PUT /v1/test-runs/:runId/criteria` → 400 with `code` `VALIDATION_FAILED` or `STATEMENT_ONLY_EDIT` and `issues`, or 200 with the saved revision (edited criteria carry the generated statement and `ambiguity: null`).

- [ ] **Step 1: Write the unit tests** — `apps/api/src/services/criteria-edit.test.ts`

```ts
import { describeExpectedOutcome, type AcceptanceCriterion, type NormalizedRequirement } from "@platform/contracts";
import { describe, expect, it } from "vitest";
import { applyCriteriaEdit } from "./criteria-edit";

const facts: NormalizedRequirement["facts"] = [
  { key: "cartCount", checkpoint: "before_add", description: "Cart badge count", valueType: "number" },
  { key: "cartCount", checkpoint: "after_add", description: "Cart badge count", valueType: "number" },
  { key: "message", checkpoint: "after_add", description: "Confirmation text", valueType: "string" },
  { key: "items", checkpoint: "cart_page", description: "Items in the cart", valueType: "string_list" },
  { key: "banner", checkpoint: "home", description: "Cookie banner", valueType: "boolean" },
];
const ref = (key: string, checkpoint: string) => ({ key, checkpoint });

function criterion(id: string, expectedOutcome: AcceptanceCriterion["expectedOutcome"], patch: Partial<AcceptanceCriterion> = {}): AcceptanceCriterion {
  return { id, sourceText: "The cart holds 1 item.", statement: `${id} as the model wrote it`, expectedOutcome, preconditions: [], ambiguity: null, ...patch };
}

function latest(): NormalizedRequirement {
  return {
    runId: "run_1",
    revision: 1,
    originalText: "The cart holds 1 item. A message appears. The cart lists the product. No banner.",
    confirmedAt: null,
    facts,
    criteria: [
      criterion("AC-1", { kind: "numeric_compare", left: ref("cartCount", "after_add"), operator: "eq", right: 1 }, {
        statement: "The cart holds 1 item",
        ambiguity: { reason: "Which count?", suggestions: [] },
      }),
      criterion("AC-2", { kind: "text_matches", fact: ref("message", "after_add"), match: { mode: "contains", value: "added", caseSensitive: false } }),
      criterion("AC-3", { kind: "numeric_delta", before: ref("cartCount", "before_add"), after: ref("cartCount", "after_add"), delta: 1 }),
      criterion("AC-4", { kind: "collection_contains", collection: ref("items", "cart_page"), item: "iPhone", match: "contains" }),
      criterion("AC-5", { kind: "visible", fact: ref("banner", "home"), expected: false }),
      criterion("AC-6", { kind: "semantic", description: "Looks right" }),
    ],
  };
}

/** The body a client sends: the latest revision with `edit` applied to one criterion. */
function bodyWith(id: string, edit: (c: AcceptanceCriterion) => AcceptanceCriterion) {
  const l = latest();
  return { criteria: l.criteria.map((c) => (c.id === id ? edit(c) : c)), facts: l.facts };
}
const outcomeOf = <K extends AcceptanceCriterion["expectedOutcome"]["kind"]>(c: AcceptanceCriterion, _kind: K) =>
  c.expectedOutcome as Extract<AcceptanceCriterion["expectedOutcome"], { kind: K }>;

describe("applyCriteriaEdit", () => {
  it("accepts an unchanged body and returns the latest criteria as they are", () => {
    const l = latest();
    const r = applyCriteriaEdit(l, { criteria: l.criteria, facts: l.facts });
    expect(r).toEqual({ ok: true, criteria: l.criteria, facts: l.facts });
  });

  it("regression: '1 item' → '2 items' changes the check, and the server writes the wording from it", () => {
    const r = applyCriteriaEdit(latest(), bodyWith("AC-1", (c) => ({ ...c, expectedOutcome: { ...outcomeOf(c, "numeric_compare"), right: 2 } })));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ac1 = r.criteria[0]!;
    expect(ac1.expectedOutcome).toEqual({ kind: "numeric_compare", left: ref("cartCount", "after_add"), operator: "eq", right: 2 });
    expect(ac1.statement).toBe("Cart badge count (at “after add”) equals 2.");
    expect(ac1.ambiguity).toBeNull();
  });

  it("ignores the statement a client sends with an edited check", () => {
    const r = applyCriteriaEdit(latest(), bodyWith("AC-3", (c) => ({ ...c, statement: "anything", expectedOutcome: { ...outcomeOf(c, "numeric_delta"), delta: 2 } })));
    expect(r.ok && r.criteria[2]!.statement).toBe(describeExpectedOutcome({ ...outcomeOf(latest().criteria[2]!, "numeric_delta"), delta: 2 }, facts));
  });

  it.each([
    ["visible expected", "AC-5", (c: AcceptanceCriterion) => ({ ...c, expectedOutcome: { ...outcomeOf(c, "visible"), expected: true } })],
    ["text mode/value/case", "AC-2", (c: AcceptanceCriterion) => ({ ...c, expectedOutcome: { ...outcomeOf(c, "text_matches"), match: { mode: "equals" as const, value: "Added!", caseSensitive: true } } })],
    ["compare operator", "AC-1", (c: AcceptanceCriterion) => ({ ...c, expectedOutcome: { ...outcomeOf(c, "numeric_compare"), operator: "gte" as const } })],
    ["delta", "AC-3", (c: AcceptanceCriterion) => ({ ...c, expectedOutcome: { ...outcomeOf(c, "numeric_delta"), delta: -1 } })],
    ["collection item and match", "AC-4", (c: AcceptanceCriterion) => ({ ...c, expectedOutcome: { ...outcomeOf(c, "collection_contains"), item: "iPhone 17 Pro", match: "equals" as const } })],
  ])("accepts an edit of %s", (_name, id, edit) => {
    const r = applyCriteriaEdit(latest(), bodyWith(id, edit));
    expect(r.ok).toBe(true);
    const saved = r.ok ? r.criteria.find((c) => c.id === id)! : null;
    expect(saved!.statement).toBe(describeExpectedOutcome(saved!.expectedOutcome, facts));
  });

  it("accepts removing a criterion, and drops facts no remaining criterion reads", () => {
    const l = latest();
    const r = applyCriteriaEdit(l, { criteria: l.criteria.filter((c) => c.id !== "AC-5"), facts: l.facts.filter((f) => f.key !== "banner") });
    expect(r.ok).toBe(true);
    expect(r.ok && r.criteria.map((c) => c.id)).toEqual(["AC-1", "AC-2", "AC-3", "AC-4", "AC-6"]);
    expect(r.ok && r.facts.some((f) => f.key === "banner")).toBe(false);
  });

  it("accepts editing an already-edited criterion again", () => {
    const first = applyCriteriaEdit(latest(), bodyWith("AC-1", (c) => ({ ...c, expectedOutcome: { ...outcomeOf(c, "numeric_compare"), right: 2 } })));
    if (!first.ok) throw new Error("first edit failed");
    const revision2: NormalizedRequirement = { ...latest(), revision: 2, criteria: first.criteria };
    const r = applyCriteriaEdit(revision2, {
      criteria: first.criteria.map((c) => (c.id === "AC-1" ? { ...c, expectedOutcome: { ...outcomeOf(c, "numeric_compare"), right: 3 } } : c)),
      facts,
    });
    expect(r.ok && r.criteria[0]!.statement).toBe("Cart badge count (at “after add”) equals 3.");
  });

  it("rejects a wording-only change with STATEMENT_ONLY_EDIT", () => {
    const r = applyCriteriaEdit(latest(), bodyWith("AC-1", (c) => ({ ...c, statement: "The cart holds 2 items" })));
    expect(r).toEqual({ ok: false, code: "STATEMENT_ONLY_EDIT", issues: [{ path: ["criteria", 0, "statement"], message: expect.any(String) }] });
  });

  it.each([
    ["an added criterion", (l: NormalizedRequirement) => ({ criteria: [...l.criteria, { ...l.criteria[1]!, id: "AC-9" }], facts: l.facts }), ["criteria", 6, "id"]],
    ["a changed sourceText", (l: NormalizedRequirement) => bodyWith("AC-2", (c) => ({ ...c, sourceText: "A message appears." })), ["criteria", 1, "sourceText"]],
    ["changed preconditions", (l: NormalizedRequirement) => bodyWith("AC-2", (c) => ({ ...c, preconditions: [{ kind: "authenticated" as const, description: "x" }] })), ["criteria", 1, "preconditions"]],
    ["a changed kind", (l: NormalizedRequirement) => bodyWith("AC-5", (c) => ({ ...c, expectedOutcome: { kind: "semantic" as const, description: "banner hidden" } })), ["criteria", 4, "expectedOutcome"]],
    ["a changed fact reference", (l: NormalizedRequirement) => bodyWith("AC-1", (c) => ({ ...c, expectedOutcome: { ...outcomeOf(c, "numeric_compare"), left: ref("cartCount", "before_add") } })), ["criteria", 0, "expectedOutcome"]],
    ["a literal replaced by a fact", (l: NormalizedRequirement) => bodyWith("AC-1", (c) => ({ ...c, expectedOutcome: { ...outcomeOf(c, "numeric_compare"), right: ref("cartCount", "before_add") } })), ["criteria", 0, "expectedOutcome"]],
    ["an edited semantic description", (l: NormalizedRequirement) => bodyWith("AC-6", (c) => ({ ...c, expectedOutcome: { kind: "semantic" as const, description: "Looks great" } })), ["criteria", 5, "expectedOutcome"]],
    ["a changed ambiguity on an unedited criterion", (l: NormalizedRequirement) => bodyWith("AC-1", (c) => ({ ...c, ambiguity: null })), ["criteria", 0, "ambiguity"]],
    ["an added fact", (l: NormalizedRequirement) => ({ criteria: l.criteria, facts: [...l.facts, { key: "extra", checkpoint: "home", description: "Extra", valueType: "string" as const }] }), ["facts", 5]],
    ["a changed fact description", (l: NormalizedRequirement) => ({ criteria: l.criteria, facts: l.facts.map((f, i) => (i === 0 ? { ...f, description: "Badge" } : f)) }), ["facts", 0]],
    ["an edited regex that does not compile", (l: NormalizedRequirement) => bodyWith("AC-2", (c) => ({ ...c, expectedOutcome: { ...outcomeOf(c, "text_matches"), match: { mode: "regex" as const, value: "(", caseSensitive: false } } })), ["criteria", 1, "expectedOutcome", "match", "value"]],
  ])("rejects %s with VALIDATION_FAILED", (_name, make, path) => {
    const r = applyCriteriaEdit(latest(), make(latest()));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("VALIDATION_FAILED");
    expect(r.issues.map((i) => i.path)).toContainEqual(path);
  });

  it("reports rule violations before a wording-only change", () => {
    const l = latest();
    const body = bodyWith("AC-1", (c) => ({ ...c, statement: "reworded" }));
    body.criteria[1] = { ...body.criteria[1]!, sourceText: "changed" };
    const r = applyCriteriaEdit(l, body);
    expect(!r.ok && r.code).toBe("VALIDATION_FAILED");
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @platform/api exec vitest run src/services/criteria-edit.test.ts`
Expected: FAIL — `Cannot find module './criteria-edit'`.

- [ ] **Step 3: Implement `apps/api/src/services/criteria-edit.ts`**

```ts
import {
  describeExpectedOutcome,
  type AcceptanceCriterion,
  type ExpectedOutcome,
  type FactRequest,
  type NormalizedRequirement,
} from "@platform/contracts";

/** The verifier's regex limit (packages/testing-engine/src/verification/normalize.ts, MAX_REGEX_LENGTH). */
const MAX_REGEX_LENGTH = 500;

export interface EditIssue {
  path: (string | number)[];
  message: string;
}

export type EditResult =
  | { ok: true; criteria: AcceptanceCriterion[]; facts: FactRequest[] }
  | { ok: false; code: "VALIDATION_FAILED" | "STATEMENT_ONLY_EDIT"; issues: EditIssue[] };

/** JSON with object keys sorted, so equal values compare equal whatever their key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/**
 * The parts of a check that pin *what* it reads (its kind and every fact it references, and
 * whether a compared value is a literal or a fact). Only the rest — the literal values — may be
 * edited during review; the planner and explorer depend on what a check reads.
 */
function fixedParts(o: ExpectedOutcome): unknown {
  switch (o.kind) {
    case "visible":
    case "text_matches":
      return { kind: o.kind, fact: o.fact };
    case "numeric_compare":
      return { kind: o.kind, left: o.left, right: typeof o.right === "number" ? "literal" : o.right };
    case "numeric_delta":
      return { kind: o.kind, before: o.before, after: o.after };
    case "collection_contains":
      return { kind: o.kind, collection: o.collection, item: typeof o.item === "string" ? "literal" : o.item };
    case "semantic":
      return o; // nothing is editable: it can only be removed
  }
}

function compiles(pattern: string, caseSensitive: boolean): boolean {
  if (pattern.length > MAX_REGEX_LENGTH) return false;
  try {
    new RegExp(pattern, caseSensitive ? "" : "i");
    return true;
  } catch {
    return false;
  }
}

/**
 * Criteria review edits (spec: docs/superpowers/specs/2026-09-26-criteria-check-edit-design.md).
 * Compares a PUT body (already parsed with NormalizedRequirementSchema) with the latest revision:
 * criteria may be removed, and a criterion's check may change its literal values. For an edited
 * criterion the server writes the statement from the check and clears `ambiguity`, so the wording
 * can never describe a different check than the one the verifier runs. Anything else is rejected.
 * Unedited criteria are returned exactly as in the latest revision.
 */
export function applyCriteriaEdit(latest: NormalizedRequirement, body: Pick<NormalizedRequirement, "criteria" | "facts">): EditResult {
  const invalid: EditIssue[] = [];
  const wordingOnly: EditIssue[] = [];

  const knownFacts = new Map(latest.facts.map((f) => [`${f.key}@${f.checkpoint}`, f]));
  body.facts.forEach((f, j) => {
    const before = knownFacts.get(`${f.key}@${f.checkpoint}`);
    if (!before || !same(before, f)) invalid.push({ path: ["facts", j], message: "Facts cannot be added or changed during review" });
  });

  const byId = new Map(latest.criteria.map((c) => [c.id, c]));
  const criteria: AcceptanceCriterion[] = [];
  body.criteria.forEach((c, i) => {
    const at = (...rest: (string | number)[]) => ["criteria", i, ...rest];
    const before = byId.get(c.id);
    if (!before) {
      invalid.push({ path: at("id"), message: `${c.id} was not proposed for this run; start over with a revised requirement to add criteria` });
      return;
    }
    if (c.sourceText !== before.sourceText) invalid.push({ path: at("sourceText"), message: "sourceText cannot change" });
    if (!same(c.preconditions, before.preconditions)) invalid.push({ path: at("preconditions"), message: "preconditions cannot change" });
    if (!same(fixedParts(c.expectedOutcome), fixedParts(before.expectedOutcome))) {
      invalid.push({ path: at("expectedOutcome"), message: "Only the check's values can change, not what it reads" });
      return;
    }

    const outcome = c.expectedOutcome;
    if (!same(outcome, before.expectedOutcome)) {
      if (outcome.kind === "text_matches" && outcome.match.mode === "regex" && !compiles(outcome.match.value, outcome.match.caseSensitive)) {
        invalid.push({ path: at("expectedOutcome", "match", "value"), message: "Not a valid pattern" });
        return;
      }
      criteria.push({ ...before, expectedOutcome: outcome, statement: describeExpectedOutcome(outcome, body.facts), ambiguity: null });
      return;
    }
    if (c.statement !== before.statement) wordingOnly.push({ path: at("statement"), message: "Change the check, not only its wording" });
    if (!same(c.ambiguity, before.ambiguity)) invalid.push({ path: at("ambiguity"), message: "ambiguity changes only with the check" });
    criteria.push(before);
  });

  if (invalid.length > 0) return { ok: false, code: "VALIDATION_FAILED", issues: invalid };
  if (wordingOnly.length > 0) return { ok: false, code: "STATEMENT_ONLY_EDIT", issues: wordingOnly };
  return { ok: true, criteria, facts: body.facts };
}
```

- [ ] **Step 4: Run the unit tests**

Run: `pnpm --filter @platform/api exec vitest run src/services/criteria-edit.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the route tests** — in `apps/api/src/routes/test-run-criteria.test.ts`

(a) Update the existing test `"saves an edited requirement as revision n+1 and publishes criteria.updated"`: it edits AC-2's check and statement, so the server now writes the statement. Replace

```ts
    expect(body.criteria[0].statement).toBe("A confirmation banner appears");
```

with

```ts
    // The check changed, so the server wrote the wording from it (the client's text is ignored).
    expect(body.criteria[0].statement).toBe("Confirmation text (at “after add”) contains “added” (ignoring case).");
```

(b) Add inside `describe("PUT /v1/test-runs/:runId/criteria", …)`:

```ts
  /** "The cart holds 1 item": a numeric check against a literal. */
  function oneItemRequirement(): Draft {
    const base = baseRequirement();
    return {
      ...base,
      criteria: [
        {
          id: "AC-1",
          sourceText: "The cart count should increase.",
          statement: "The cart holds 1 item",
          expectedOutcome: { kind: "numeric_compare", left: { key: "cartCount", checkpoint: "after_add" }, operator: "eq", right: 1 },
          preconditions: [],
          ambiguity: null,
        },
      ],
      facts: base.facts.filter((f) => f.key === "cartCount"),
    };
  }

  it("regression: rewording '1 item' to '2 items' is refused; changing the check to 2 saves a check and wording that both say 2", async () => {
    const runId = await setupAwaitingConfirmation(oneItemRequirement());
    const current = getCriteriaBody(await getCriteria(runId));

    const reworded = await putCriteria(runId, { ...current, criteria: [{ ...current.criteria[0], statement: "The cart holds 2 items" }] });
    expect(reworded.statusCode).toBe(400);
    expect(reworded.json()).toMatchObject({ code: "STATEMENT_ONLY_EDIT", issues: [{ path: ["criteria", 0, "statement"] }] });
    expect(getCriteriaBody(await getCriteria(runId)).revision).toBe(1); // nothing saved

    const edited = await putCriteria(runId, {
      ...current,
      criteria: [{ ...current.criteria[0], expectedOutcome: { ...current.criteria[0].expectedOutcome, right: 2 } }],
    });
    expect(edited.statusCode).toBe(200);
    const saved = edited.json();
    expect(saved.revision).toBe(2);
    expect(saved.criteria[0].expectedOutcome.right).toBe(2);
    expect(saved.criteria[0].statement).toBe("Cart badge count (at “after add”) equals 2.");
  });

  it("clears ambiguity on an edited criterion and keeps it on an unedited one", async () => {
    const runId = await setupAwaitingConfirmation(requirementWithWarnings());
    const current = getCriteriaBody(await getCriteria(runId));
    const [ac1, ac2, ac3] = current.criteria;
    const res = await putCriteria(runId, {
      ...current,
      criteria: [{ ...ac1, expectedOutcome: { ...ac1.expectedOutcome, operator: "gte" } }, ac2, ac3],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().criteria[0].ambiguity).toBeNull();
    expect(res.json().criteria[0].statement).toBe("Cart badge count (at “after add”) is at least Cart badge count (at “before add”).");
  });

  it("rejects changing what a check reads with 400 VALIDATION_FAILED and an issue path", async () => {
    const runId = await setupAwaitingConfirmation();
    const current = getCriteriaBody(await getCriteria(runId));
    const [ac1, ac2] = current.criteria;
    const res = await putCriteria(runId, {
      ...current,
      criteria: [{ ...ac1, expectedOutcome: { ...ac1.expectedOutcome, left: { key: "cartCount", checkpoint: "before_add" } } }, ac2],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "VALIDATION_FAILED", issues: [{ path: ["criteria", 0, "expectedOutcome"] }] });
  });
```

Check that `getCriteriaBody` (defined further down the file for the existing tests) is in scope where you add these; if it is declared later with `const`, place the new tests after it or turn it into a `function` declaration.

- [ ] **Step 6: Run the route tests to see the new ones fail**

Run: `pnpm --filter @platform/api exec vitest run src/routes/test-run-criteria.test.ts`
Expected: FAIL — the reworded PUT returns 200, the updated statement assertion fails.

- [ ] **Step 7: Wire the helper into `CriteriaService.update`** (`apps/api/src/services/criteria-service.ts`)

Add the import `import { applyCriteriaEdit } from "./criteria-edit";` and replace the body of `update` from `const latest = …` down to the `createRevision` call with:

```ts
    const latest = await this.requirements.findLatest(runId);
    if (latest && latest.originalText !== req.originalText) {
      throw new HttpError(400, "VALIDATION_FAILED", "originalText cannot change between revisions", [
        { path: ["originalText"], message: "originalText cannot change between revisions" },
      ]);
    }

    // Review edits (spec 2026-09-26-criteria-check-edit): only while the run waits for confirmation.
    // In any other state createRevision's lifecycle/frozen guards answer 409, as before.
    let criteria = req.criteria;
    let facts = req.facts;
    if (latest && !latest.confirmedAt && run.lifecycle === "AWAITING_CONFIRMATION") {
      const edit = applyCriteriaEdit(latest, req);
      if (!edit.ok) {
        const message =
          edit.code === "STATEMENT_ONLY_EDIT"
            ? "A criterion's wording can only change together with its check"
            : "Only a criterion's check values can change during review";
        throw new HttpError(400, edit.code, message, edit.issues);
      }
      ({ criteria, facts } = edit);
    }

    const updated = await this.requirements.createRevision(runId, { originalText: req.originalText, criteria, facts });
```

Update the method's doc comment: "Saves a new revision … Criteria may be removed and a criterion's check values edited; the server writes the statement of every edited criterion (applyCriteriaEdit)."

- [ ] **Step 8: Run the API suite**

Run: `pnpm --filter @platform/api test && pnpm --filter @platform/api typecheck`
Expected: PASS (all route tests, including the existing "removing every criterion → 400", "PUT after confirm → 409", "other tenant → 404").

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/services/criteria-edit.ts apps/api/src/services/criteria-edit.test.ts apps/api/src/services/criteria-service.ts apps/api/src/routes/test-run-criteria.test.ts
git commit -m "feat: criteria review edits a check's values; the server writes its wording

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Web — "Edit check" replaces the wording editor

**Files:**
- Create: `apps/web/components/CheckEditor.tsx`
- Create: `apps/web/components/CheckEditor.test.tsx`
- Modify: `apps/web/components/CriterionCard.tsx`
- Modify: `apps/web/components/CriteriaReview.tsx`
- Modify: `apps/web/components/CriteriaReview.test.tsx`
- Modify: `apps/web/app/globals.css` (only if the form needs a class not already defined — reuse `.field`, `.actions`, `.hint`, `.field-error`, `.button*`)

**Interfaces:**
- Consumes: `describeExpectedOutcome` from `@platform/contracts` (Task 1); API behavior from Task 2 (400 `issues`, server-written statement).
- Produces: `CheckEditor` props `{ criterionId: string; outcome: EditableOutcome; facts: readonly FactRequest[]; busy: boolean; serverError: string | null; onSave(outcome: ExpectedOutcome): void; onDiscard(): void }` where `EditableOutcome = Exclude<ExpectedOutcome, { kind: "semantic" }>`. `CriterionCard.onSave` becomes `(outcome: ExpectedOutcome) => Promise<string | null>` (null = saved, string = error to show inline).

- [ ] **Step 1: Write `CheckEditor.test.tsx`**

```tsx
import type { ExpectedOutcome, FactRequest } from "@platform/contracts";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CheckEditor, type EditableOutcome } from "./CheckEditor";

const facts: FactRequest[] = [
  { key: "cartCount", checkpoint: "before_add", description: "Cart badge count", valueType: "number" },
  { key: "cartCount", checkpoint: "after_add", description: "Cart badge count", valueType: "number" },
  { key: "message", checkpoint: "after_add", description: "Confirmation text", valueType: "string" },
  { key: "items", checkpoint: "cart_page", description: "Items in the cart", valueType: "string_list" },
  { key: "banner", checkpoint: "home", description: "Cookie banner", valueType: "boolean" },
];
const ref = (key: string, checkpoint: string) => ({ key, checkpoint });

function setup(outcome: EditableOutcome) {
  const onSave = vi.fn<(o: ExpectedOutcome) => void>();
  const user = userEvent.setup();
  render(<CheckEditor criterionId="AC-1" outcome={outcome} facts={facts} busy={false} serverError={null} onSave={onSave} onDiscard={() => {}} />);
  return { onSave, user };
}

describe("CheckEditor", () => {
  it("numeric compare against a literal: operator and number, with a live preview", async () => {
    const { onSave, user } = setup({ kind: "numeric_compare", left: ref("cartCount", "after_add"), operator: "eq", right: 1 });
    const value = screen.getByLabelText(/compared with/i);
    await user.clear(value);
    await user.type(value, "2");
    await user.selectOptions(screen.getByLabelText(/comparison/i), "gte");
    expect(screen.getByText("Cart badge count (at “after add”) is at least 2.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /save check/i }));
    expect(onSave).toHaveBeenCalledWith({ kind: "numeric_compare", left: ref("cartCount", "after_add"), operator: "gte", right: 2 });
  });

  it("numeric compare against another fact: only the operator is editable", () => {
    setup({ kind: "numeric_compare", left: ref("cartCount", "after_add"), operator: "gt", right: ref("cartCount", "before_add") });
    expect(screen.getByLabelText(/comparison/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/compared with/i)).not.toBeInTheDocument();
  });

  it.each(["", "abc", "1e400"])("refuses to save a number field of %j", async (typed) => {
    const { onSave, user } = setup({ kind: "numeric_delta", before: ref("cartCount", "before_add"), after: ref("cartCount", "after_add"), delta: 1 });
    const field = screen.getByLabelText(/difference/i);
    await user.clear(field);
    if (typed) await user.type(field, typed);
    await user.click(screen.getByRole("button", { name: /save check/i }));
    expect(onSave).not.toHaveBeenCalled();
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription(/enter a number/i);
  });

  it("text check: mode, value and case", async () => {
    const { onSave, user } = setup({ kind: "text_matches", fact: ref("message", "after_add"), match: { mode: "contains", value: "added", caseSensitive: false } });
    await user.selectOptions(screen.getByLabelText(/how it matches/i), "equals");
    const value = screen.getByLabelText(/^text$/i);
    await user.clear(value);
    await user.type(value, "Added to cart");
    await user.click(screen.getByLabelText(/match case/i));
    await user.click(screen.getByRole("button", { name: /save check/i }));
    expect(onSave).toHaveBeenCalledWith({ kind: "text_matches", fact: ref("message", "after_add"), match: { mode: "equals", value: "Added to cart", caseSensitive: true } });
  });

  it("refuses a regex that does not compile, and empty text", async () => {
    const { onSave, user } = setup({ kind: "text_matches", fact: ref("message", "after_add"), match: { mode: "regex", value: "^added", caseSensitive: false } });
    const value = screen.getByLabelText(/^pattern$/i);
    await user.clear(value);
    await user.type(value, "(");
    await user.click(screen.getByRole("button", { name: /save check/i }));
    expect(value).toHaveAccessibleDescription(/not a valid pattern/i);
    await user.clear(value);
    await user.click(screen.getByRole("button", { name: /save check/i }));
    expect(value).toHaveAccessibleDescription(/enter 1 to 500 characters/i);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("visibility: shown or not shown", async () => {
    const { onSave, user } = setup({ kind: "visible", fact: ref("banner", "home"), expected: false });
    await user.click(screen.getByLabelText(/^shown$/i));
    await user.click(screen.getByRole("button", { name: /save check/i }));
    expect(onSave).toHaveBeenCalledWith({ kind: "visible", fact: ref("banner", "home"), expected: true });
  });

  it("list check: item text and match", async () => {
    const { onSave, user } = setup({ kind: "collection_contains", collection: ref("items", "cart_page"), item: "iPhone", match: "contains" });
    const item = screen.getByLabelText(/^item$/i);
    await user.clear(item);
    await user.type(item, "iPhone 17 Pro");
    await user.selectOptions(screen.getByLabelText(/how it matches/i), "equals");
    await user.click(screen.getByRole("button", { name: /save check/i }));
    expect(onSave).toHaveBeenCalledWith({ kind: "collection_contains", collection: ref("items", "cart_page"), item: "iPhone 17 Pro", match: "equals" });
  });

  it("shows a server error inline", () => {
    render(
      <CheckEditor
        criterionId="AC-1"
        outcome={{ kind: "visible", fact: ref("banner", "home"), expected: true }}
        facts={facts}
        busy={false}
        serverError="Only a criterion's check values can change during review"
        onSave={() => {}}
        onDiscard={() => {}}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Only a criterion's check values can change during review");
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @platform/web exec vitest run components/CheckEditor.test.tsx`
Expected: FAIL — `Cannot find module './CheckEditor'`.

- [ ] **Step 3: Implement `apps/web/components/CheckEditor.tsx`**

```tsx
"use client";

import { describeExpectedOutcome, type ExpectedOutcome, type FactRequest } from "@platform/contracts";
import { useId, useState } from "react";
import { Icon } from "./Icon";

export type EditableOutcome = Exclude<ExpectedOutcome, { kind: "semantic" }>;

interface Props {
  criterionId: string;
  outcome: EditableOutcome;
  facts: readonly FactRequest[];
  busy: boolean;
  /** The API's answer to the last save, shown inline. */
  serverError: string | null;
  onSave: (outcome: ExpectedOutcome) => void;
  onDiscard: () => void;
}

type Compare = Extract<ExpectedOutcome, { kind: "numeric_compare" }>["operator"];
const OPERATORS: [Compare, string][] = [
  ["eq", "equals"],
  ["neq", "does not equal"],
  ["gt", "is greater than"],
  ["gte", "is at least"],
  ["lt", "is less than"],
  ["lte", "is at most"],
];

/** Everything a user can change, as the form holds it (numbers as typed text). */
interface Draft {
  expected: boolean;
  mode: "equals" | "contains" | "regex";
  text: string;
  caseSensitive: boolean;
  operator: Compare;
  number: string;
  match: "equals" | "contains";
}

function draftOf(o: EditableOutcome): Draft {
  const d: Draft = { expected: true, mode: "contains", text: "", caseSensitive: false, operator: "eq", number: "", match: "contains" };
  switch (o.kind) {
    case "visible":
      return { ...d, expected: o.expected };
    case "text_matches":
      return { ...d, mode: o.match.mode, text: o.match.value, caseSensitive: o.match.caseSensitive };
    case "numeric_compare":
      return { ...d, operator: o.operator, number: typeof o.right === "number" ? String(o.right) : "" };
    case "numeric_delta":
      return { ...d, number: String(o.delta) };
    case "collection_contains":
      return { ...d, match: o.match, text: typeof o.item === "string" ? o.item : "" };
  }
}

const parseNumber = (s: string): number | null => {
  if (s.trim() === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const textOk = (s: string) => s.trim().length > 0 && s.length <= 500;
const compiles = (pattern: string, caseSensitive: boolean) => {
  try {
    new RegExp(pattern, caseSensitive ? "" : "i");
    return true;
  } catch {
    return false;
  }
};

/** The edited check, or the field errors that stop it (mirrors the contract and the API's rules). */
function build(o: EditableOutcome, d: Draft): { outcome: ExpectedOutcome } | { errors: Partial<Record<"number" | "text", string>> } {
  switch (o.kind) {
    case "visible":
      return { outcome: { ...o, expected: d.expected } };
    case "text_matches":
      if (!textOk(d.text)) return { errors: { text: "Enter 1 to 500 characters." } };
      if (d.mode === "regex" && !compiles(d.text, d.caseSensitive)) return { errors: { text: "Not a valid pattern." } };
      return { outcome: { ...o, match: { mode: d.mode, value: d.text, caseSensitive: d.caseSensitive } } };
    case "numeric_compare": {
      if (typeof o.right !== "number") return { outcome: { ...o, operator: d.operator } };
      const n = parseNumber(d.number);
      return n === null ? { errors: { number: "Enter a number." } } : { outcome: { ...o, operator: d.operator, right: n } };
    }
    case "numeric_delta": {
      const n = parseNumber(d.number);
      return n === null ? { errors: { number: "Enter a number." } } : { outcome: { ...o, delta: n } };
    }
    case "collection_contains":
      if (typeof o.item !== "string") return { outcome: { ...o, match: d.match } };
      if (!textOk(d.text)) return { errors: { text: "Enter 1 to 500 characters." } };
      return { outcome: { ...o, item: d.text, match: d.match } };
  }
}

/**
 * Edits a criterion's check — only its literal values; what it reads stays fixed (spec
 * 2026-09-26-criteria-check-edit). The preview is the statement the server will write.
 */
export function CheckEditor({ criterionId, outcome, facts, busy, serverError, onSave, onDiscard }: Props) {
  const uid = useId();
  const [draft, setDraft] = useState<Draft>(() => draftOf(outcome));
  const [shown, setShown] = useState<Partial<Record<"number" | "text", string>>>({});
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const built = build(outcome, draft);
  const id = (name: string) => `${uid}-${name}`;
  const described = (field: "number" | "text") => (shown[field] ? id(`${field}-error`) : undefined);
  const fieldError = (field: "number" | "text") =>
    shown[field] ? (
      <p id={id(`${field}-error`)} className="field-error">
        <Icon name="error" /> {shown[field]}
      </p>
    ) : null;

  function save() {
    if ("errors" in built) {
      setShown(built.errors);
      return;
    }
    setShown({});
    onSave(built.outcome);
  }

  const numberField = (label: string) => (
    <div className="field">
      <label htmlFor={id("number")}>{label}</label>
      <input
        id={id("number")}
        inputMode="decimal"
        value={draft.number}
        onChange={(e) => set({ number: e.target.value })}
        aria-invalid={shown.number ? true : undefined}
        aria-describedby={described("number")}
      />
      {fieldError("number")}
    </div>
  );
  const textField = (label: string) => (
    <div className="field">
      <label htmlFor={id("text")}>{label}</label>
      <input
        id={id("text")}
        value={draft.text}
        onChange={(e) => set({ text: e.target.value })}
        aria-invalid={shown.text ? true : undefined}
        aria-describedby={described("text")}
      />
      {fieldError("text")}
    </div>
  );

  return (
    <div className="check-editor stack" role="group" aria-label={`Edit the check of ${criterionId}`}>
      {outcome.kind === "visible" && (
        <fieldset className="field">
          <legend>The element should be</legend>
          <label>
            <input type="radio" name={id("visible")} checked={draft.expected} onChange={() => set({ expected: true })} /> Shown
          </label>
          <label>
            <input type="radio" name={id("visible")} checked={!draft.expected} onChange={() => set({ expected: false })} /> Not shown
          </label>
        </fieldset>
      )}

      {outcome.kind === "text_matches" && (
        <>
          <div className="field">
            <label htmlFor={id("mode")}>How it matches</label>
            <select id={id("mode")} value={draft.mode} onChange={(e) => set({ mode: e.target.value as Draft["mode"] })}>
              <option value="contains">Contains</option>
              <option value="equals">Is exactly</option>
              <option value="regex">Matches the pattern</option>
            </select>
          </div>
          {textField(draft.mode === "regex" ? "Pattern" : "Text")}
          <label>
            <input type="checkbox" checked={draft.caseSensitive} onChange={(e) => set({ caseSensitive: e.target.checked })} /> Match case
          </label>
        </>
      )}

      {outcome.kind === "numeric_compare" && (
        <>
          <div className="field">
            <label htmlFor={id("operator")}>Comparison</label>
            <select id={id("operator")} value={draft.operator} onChange={(e) => set({ operator: e.target.value as Compare })}>
              {OPERATORS.map(([value, words]) => (
                <option key={value} value={value}>
                  {words}
                </option>
              ))}
            </select>
          </div>
          {typeof outcome.right === "number" && numberField("Compared with")}
        </>
      )}

      {outcome.kind === "numeric_delta" && numberField("Difference (after − before)")}

      {outcome.kind === "collection_contains" && (
        <>
          <div className="field">
            <label htmlFor={id("match")}>How it matches</label>
            <select id={id("match")} value={draft.match} onChange={(e) => set({ match: e.target.value as Draft["match"] })}>
              <option value="contains">Contains</option>
              <option value="equals">Is exactly</option>
            </select>
          </div>
          {typeof outcome.item === "string" && textField("Item")}
        </>
      )}

      <div className="criterion-check">
        <p className="criterion-check-title">New wording</p>
        <p>{"outcome" in built ? describeExpectedOutcome(built.outcome, facts) : "—"}</p>
      </div>

      {serverError && (
        <p role="alert" className="field-error">
          <Icon name="error" /> {serverError}
        </p>
      )}

      <div className="actions">
        <button type="button" className="button button-primary" onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save check"}
        </button>
        <button type="button" className="button button-quiet" onClick={onDiscard} disabled={busy}>
          Discard
        </button>
      </div>
    </div>
  );
}
```

If `Icon` has no `"error"` name, use the name `CriterionCard.tsx` already uses for field errors (it uses `"error"`).

- [ ] **Step 4: Run the CheckEditor tests**

Run: `pnpm --filter @platform/web exec vitest run components/CheckEditor.test.tsx`
Expected: PASS.

- [ ] **Step 5: Rewrite the review tests for the new editor** — `apps/web/components/CriteriaReview.test.tsx`

Delete the three tests that exercised free-text rewording: `"says a reworded criterion keeps its check: while editing, and after saving"`, `"drops the reworded note when an edit is discarded or saved back to the original wording"`, and `"editing a criterion sends PUT with the full requirement"`. In the tests `"won't confirm while an edit is open, and says which one"`, `"keeps another card's open draft when a different criterion is saved"` and `"confirm is available again once the open edit is saved"`, open editors with `getByRole("button", { name: "Edit check AC-n" })` and change values through the check form instead of `getByLabelText(/criterion AC-n/i)`: for AC-2 (numeric_delta, delta 1) type into `getByLabelText(/difference/i)`; for AC-1 (compare against a fact) change `getByLabelText(/comparison/i)`; save with `/save check/i`. Assertions about saved wording become the generated sentence, e.g. `"Cart badge count (at “after add”) is exactly 2 more than Cart badge count (at “before add”)."`. Then add:

```tsx
  it("editing a check sends PUT with the edited check and its generated wording, and shows the saved revision", async () => {
    const user = userEvent.setup();
    let sent: NormalizedRequirement | null = null;
    routeFetch({
      [`GET ${CRITERIA}`]: () => json(200, requirementFixture()),
      [`PUT ${CRITERIA}`]: (init) => {
        sent = JSON.parse(String(init!.body));
        return json(200, { ...sent!, revision: 2 });
      },
    });
    render(<CriteriaReview runId="run_1" onConfirmed={() => {}} />);
    const cards = await screen.findAllByRole("article");
    await user.click(within(cards[1]!).getByRole("button", { name: "Edit check AC-2" }));
    const delta = within(cards[1]!).getByLabelText(/difference/i);
    await user.clear(delta);
    await user.type(delta, "2");
    const wording = "Cart badge count (at “after add”) is exactly 2 more than Cart badge count (at “before add”).";
    expect(within(cards[1]!).getByText(wording)).toBeInTheDocument(); // live preview
    await user.click(within(cards[1]!).getByRole("button", { name: /save check/i }));

    await waitFor(() => expect(sent).not.toBeNull());
    const expected = requirementFixture();
    const ac2 = expected.criteria[1]!;
    if (ac2.expectedOutcome.kind !== "numeric_delta") throw new Error("fixture changed: AC-2 should be a numeric_delta check");
    expected.criteria[1] = { ...ac2, expectedOutcome: { ...ac2.expectedOutcome, delta: 2 }, statement: wording, ambiguity: null };
    expect(sent).toEqual(expected);
    expect(await screen.findByText(/revision 2/i)).toBeInTheDocument();
  });

  it("an AI-judged criterion has no check editor, only Remove", async () => {
    routeFetch({ [`GET ${CRITERIA}`]: () => json(200, requirementFixture()) });
    render(<CriteriaReview runId="run_1" onConfirmed={() => {}} />);
    const cards = await screen.findAllByRole("article");
    expect(within(cards[2]!).queryByRole("button", { name: /edit check/i })).not.toBeInTheDocument();
    expect(within(cards[2]!).getByText(/judged by ai only — it can only be removed/i)).toBeInTheDocument();
    expect(within(cards[2]!).getByRole("button", { name: "Remove AC-3" })).toBeInTheDocument();
  });

  it("shows the API's 400 inline in the editor and keeps it open", async () => {
    const user = userEvent.setup();
    routeFetch({
      [`GET ${CRITERIA}`]: () => json(200, requirementFixture()),
      [`PUT ${CRITERIA}`]: () =>
        json(400, { code: "VALIDATION_FAILED", message: "Only a criterion's check values can change during review", issues: [{ path: ["criteria", 1, "expectedOutcome"], message: "Only the check's values can change, not what it reads" }] }),
    });
    render(<CriteriaReview runId="run_1" onConfirmed={() => {}} />);
    const cards = await screen.findAllByRole("article");
    await user.click(within(cards[1]!).getByRole("button", { name: "Edit check AC-2" }));
    await user.click(within(cards[1]!).getByRole("button", { name: /save check/i }));
    expect(await within(cards[1]!).findByRole("alert")).toHaveTextContent("Only the check's values can change, not what it reads");
    expect(within(cards[1]!).getByRole("button", { name: /save check/i })).toBeInTheDocument();
  });

  it("no longer offers free-text rewording", async () => {
    routeFetch({ [`GET ${CRITERIA}`]: () => json(200, requirementFixture()) });
    render(<CriteriaReview runId="run_1" onConfirmed={() => {}} />);
    await screen.findAllByRole("article");
    expect(screen.queryByRole("button", { name: /^edit AC-/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/rewording changes the description only/i)).not.toBeInTheDocument();
  });
```

- [ ] **Step 6: Run the review tests to see them fail**

Run: `pnpm --filter @platform/web exec vitest run components/CriteriaReview.test.tsx`
Expected: FAIL — no "Edit check AC-2" button.

- [ ] **Step 7: Use `CheckEditor` in `CriterionCard`**

In `apps/web/components/CriterionCard.tsx`:
- Props: replace `reworded: boolean` (delete it) and change `onSave: (statement: string) => Promise<boolean>` to `onSave: (outcome: ExpectedOutcome) => Promise<string | null>` (null = saved; a string is the error to show). Import `ExpectedOutcome` and `CheckEditor`/`EditableOutcome`.
- State: replace `draft`/`error`/`statement` with `const [serverError, setServerError] = useState<string | null>(null);` and reset the editor when this card's own check changes (a save of this card) — keep the Milestone D rule that saving another card does not close this one:

```tsx
  const checkKey = JSON.stringify(c.expectedOutcome);
  const [seenCheck, setSeenCheck] = useState(checkKey);
  if (seenCheck !== checkKey) {
    setSeenCheck(checkKey);
    setEditing(false);
    setServerError(null);
  }
```

- Render: always show `<p className="criterion-statement">{c.statement}</p>` and the "What will be checked" group; delete the textarea branch and the `(editing || reworded)` hint. When `editing` and the check is not semantic, render below the check group:

```tsx
      {editing && c.expectedOutcome.kind !== "semantic" && (
        <CheckEditor
          criterionId={c.id}
          outcome={c.expectedOutcome}
          facts={facts}
          busy={busy}
          serverError={serverError}
          onSave={async (outcome) => {
            const err = await onSave(outcome);
            setServerError(err);
            if (err === null) setEditing(false);
          }}
          onDiscard={() => {
            setEditing(false);
            setServerError(null);
          }}
        />
      )}
```

- The action row: the "Edit" button becomes `Edit check` with `aria-label={`Edit check ${c.id}`}` and is rendered only when `!aiJudged`. For AI-judged criteria add, inside the existing `aiJudged` note: `<p>Judged by AI only — it can only be removed.</p>`.

In `apps/web/components/CriteriaReview.tsx`:
- Remove the `loaded` state and the `reworded` prop.
- Make `save` return the error text instead of setting the banner when called from an editor:

```tsx
  /** Saves the full requirement with `criteria` replaced; resolves to null, or the error to show. */
  async function save(criteria: NormalizedRequirement["criteria"]): Promise<string | null> {
    if (!requirement) return "The criteria aren't loaded yet.";
    setSaving(true);
    setError(null);
    try {
      setRequirement(await updateCriteria(runId, { ...requirement, criteria }));
      return null;
    } catch (err) {
      if (err instanceof ApiRequestError && err.issues?.length) return err.issues.map((i) => i.message).join(" ");
      return messageOf(err);
    } finally {
      setSaving(false);
    }
  }
```

- Card wiring:

```tsx
            onSave={(outcome) =>
              save(
                criteria.map((x) =>
                  x.id === c.id ? { ...x, expectedOutcome: outcome, statement: describeExpectedOutcome(outcome, requirement.facts), ambiguity: null } : x,
                ),
              )
            }
            onRemove={() => void save(criteria.filter((x) => x.id !== c.id)).then((err) => err && setError(err))}
```

  (import `describeExpectedOutcome` from `@platform/contracts`). The Confirm guard (`openEdits`) is unchanged — it now tracks open check editors.
- Update the intro copy: "These are what the run will check. Adjust a check's values or remove a criterion — they're frozen once you confirm."

- [ ] **Step 8: Run the web suite and typecheck**

Run: `pnpm --filter @platform/web test && pnpm --filter @platform/web typecheck`
Expected: PASS, no act() warnings.

- [ ] **Step 9: Commit**

```bash
git add apps/web/components/CheckEditor.tsx apps/web/components/CheckEditor.test.tsx apps/web/components/CriterionCard.tsx apps/web/components/CriteriaReview.tsx apps/web/components/CriteriaReview.test.tsx apps/web/app/globals.css
git commit -m "feat: edit a criterion's check in review instead of its wording

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Start over with a revised requirement; docs

**Files:**
- Modify: `apps/web/components/CriteriaReview.tsx` (start-over action)
- Modify: `apps/web/components/CriteriaReview.test.tsx`
- Modify: `apps/web/components/NewTestForm.tsx` (`from` prop, pre-fill)
- Modify: `apps/web/components/NewTestForm.test.tsx`
- Modify: `apps/web/app/runs/new/page.tsx` (pass `from`)
- Modify: `README.md`, `docs/ai-testing-platform-implementation-plan.md` (Task 11 pointer)

**Interfaces:**
- Consumes: `cancelRun(runId)`, `getRun(runId)`, `getCriteria(runId)`, `ApiRequestError` from `apps/web/lib/api.ts`.
- Produces: route `/runs/new?from=<runId>`; `NewTestForm` prop `from?: string | null`.

- [ ] **Step 1: Write the start-over tests** — append to `CriteriaReview.test.tsx`

At the top of the file add the router mock (as `NewTestForm.test.tsx` does):

```tsx
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
beforeEach(() => push.mockReset());
```

(import `beforeEach` from vitest). `CriteriaReview` now calls `useRouter`, so every test file that renders it must mock `next/navigation` the same way — check `apps/web/components/RunView.test.tsx` (it renders the review for AWAITING_CONFIRMATION runs) and add the mock there if it is missing. Tests:

```tsx
  const CANCEL = "/api/v1/test-runs/run_1/cancel";

  it("start over: asks first, cancels the run, then opens the pre-filled new-test form", async () => {
    const user = userEvent.setup();
    const fetch = routeFetch({
      [`GET ${CRITERIA}`]: () => json(200, requirementFixture()),
      [`POST ${CANCEL}`]: () => json(200, summaryFixture({ lifecycle: "CANCELLED", cancelReason: "USER_REQUESTED" })),
    });
    render(<CriteriaReview runId="run_1" onConfirmed={() => {}} />);
    await screen.findAllByRole("article");
    await user.click(screen.getByRole("button", { name: /start over with a revised requirement/i }));
    expect(screen.getByText(/test data and secrets must be entered again/i)).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1); // nothing cancelled yet
    await user.click(screen.getByRole("button", { name: /yes, start over/i }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/runs/new?from=run_1"));
    expect(fetch.mock.calls.map(([u, i]) => `${i?.method ?? "GET"} ${String(u)}`)).toContain(`POST ${CANCEL}`);
  });

  it("start over still opens the form when the run can no longer be cancelled (409)", async () => {
    const user = userEvent.setup();
    routeFetch({
      [`GET ${CRITERIA}`]: () => json(200, requirementFixture()),
      [`POST ${CANCEL}`]: () => json(409, { code: "CONFLICT", message: "Run is CANCELLED" }),
    });
    render(<CriteriaReview runId="run_1" onConfirmed={() => {}} />);
    await screen.findAllByRole("article");
    await user.click(screen.getByRole("button", { name: /start over with a revised requirement/i }));
    await user.click(screen.getByRole("button", { name: /yes, start over/i }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/runs/new?from=run_1"));
  });

  it("start over shows an error and stays when cancelling fails otherwise", async () => {
    const user = userEvent.setup();
    routeFetch({
      [`GET ${CRITERIA}`]: () => json(200, requirementFixture()),
      [`POST ${CANCEL}`]: () => json(503, { code: "UNAVAILABLE", message: "Try again" }),
    });
    render(<CriteriaReview runId="run_1" onConfirmed={() => {}} />);
    await screen.findAllByRole("article");
    await user.click(screen.getByRole("button", { name: /start over with a revised requirement/i }));
    await user.click(screen.getByRole("button", { name: /yes, start over/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Try again");
    expect(push).not.toHaveBeenCalled();
  });
```

(`summaryFixture` comes from `../test/fixtures`; add it to the import.)

- [ ] **Step 2: Write the pre-fill tests** — append to `NewTestForm.test.tsx`

```tsx
describe("NewTestForm starting over from a run", () => {
  it("pre-fills the URL and the full requirement, and asks for test data and secrets again", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) =>
        String(url).endsWith("/criteria") ? json(200, requirementFixture()) : json(200, summaryFixture({ lifecycle: "CANCELLED" })),
      ),
    );
    render(<NewTestForm from="run_1" />);
    expect(await screen.findByDisplayValue("https://shop.example.com/")).toBeInTheDocument();
    expect(screen.getByLabelText(/requirement/i)).toHaveValue(requirementFixture().originalText);
    expect(screen.getByText(/test data and secrets must be entered again/i)).toBeInTheDocument();
  });

  it("stays empty with a notice when the earlier run can't be loaded", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(404, { code: "NOT_FOUND", message: "Not found" })));
    render(<NewTestForm from="run_missing" />);
    expect(await screen.findByText(/couldn't load the earlier run/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/website url/i)).toHaveValue("");
  });

  it("without `from` it loads nothing", () => {
    const fetch = mockFetch();
    render(<NewTestForm />);
    expect(fetch).not.toHaveBeenCalled();
  });
});
```

(import `requirementFixture`, `summaryFixture` from `../test/fixtures`.)

- [ ] **Step 3: Run both files to see them fail**

Run: `pnpm --filter @platform/web exec vitest run components/CriteriaReview.test.tsx components/NewTestForm.test.tsx`
Expected: FAIL — no start-over button; `from` ignored.

- [ ] **Step 4: Implement start over in `CriteriaReview.tsx`**

Add `import { useRouter } from "next/navigation";`, `cancelRun` to the api import, and:

```tsx
  const router = useRouter();
  const [startingOver, setStartingOver] = useState<"ask" | "working" | null>(null);

  /** Cancels this run and opens the new-test form pre-filled from it (spec 2026-09-26-criteria-check-edit). */
  async function startOver() {
    setStartingOver("working");
    setError(null);
    try {
      await cancelRun(runId);
    } catch (err) {
      // 409: the run already ended or its confirmation expired — nothing left to cancel.
      if (!(err instanceof ApiRequestError && err.status === 409)) {
        setError(messageOf(err));
        setStartingOver(null);
        return;
      }
    }
    router.push(`/runs/new?from=${encodeURIComponent(runId)}`);
  }
```

Render, inside `.form-actions` after the Confirm button's hints:

```tsx
        {startingOver === null ? (
          <button type="button" className="button button-quiet" onClick={() => setStartingOver("ask")} disabled={confirming || saving}>
            Start over with a revised requirement
          </button>
        ) : (
          <div role="group" aria-labelledby="start-over-title" className="note note-warning">
            <p id="start-over-title" className="note-title">
              Start over?
            </p>
            <p>This cancels the current run. You can edit the requirement and start a new one. Test data and secrets must be entered again.</p>
            <div className="actions">
              <button type="button" className="button button-danger" onClick={startOver} disabled={startingOver === "working"}>
                {startingOver === "working" ? "Cancelling…" : "Yes, start over"}
              </button>
              <button type="button" className="button button-secondary" onClick={() => setStartingOver(null)} disabled={startingOver === "working"} autoFocus>
                Keep reviewing
              </button>
            </div>
          </div>
        )}
```

- [ ] **Step 5: Implement the pre-fill in `NewTestForm.tsx` and pass `from` from the page**

`NewTestForm` signature becomes `export function NewTestForm({ from = null }: { from?: string | null } = {})`. Add `getRun`, `getCriteria` to the api import, `useEffect` to the React import, and:

```tsx
  /** Pre-fill when starting over from an earlier run (its URL and full requirement text only). */
  const [prefill, setPrefill] = useState<"loading" | "loaded" | "failed" | null>(from ? "loading" : null);
  useEffect(() => {
    if (!from) return;
    let live = true;
    Promise.all([getRun(from), getCriteria(from)]).then(
      ([run, req]) => {
        if (!live) return;
        setTargetUrl((v) => v || run.targetUrl);
        setRequirement((v) => v || req.originalText);
        setPrefill("loaded");
      },
      () => live && setPrefill("failed"),
    );
    return () => {
      live = false;
    };
  }, [from]);
```

Render above the first field:

```tsx
      {prefill === "loaded" && (
        <p className="banner banner-info" role="status">
          <Icon name="info" /> Copied the website and requirement from your earlier run. Test data and secrets must be entered again — they are never copied.
        </p>
      )}
      {prefill === "failed" && (
        <p className="banner banner-warning" role="status">
          <Icon name="warning" /> Couldn&apos;t load the earlier run; fill in the form below.
        </p>
      )}
```

(Use the banner classes and `Icon` names that already exist in `globals.css` / `Icon.tsx`; `NewTestForm` already imports `Icon` if it renders banners — check, else import it.)

In `apps/web/app/runs/new/page.tsx`:

```tsx
export default async function NewTestPage({ searchParams }: { searchParams: Promise<{ from?: string | string[] }> }) {
  const { from } = await searchParams;
  return (
    <div className="narrow stack">
      {/* …unchanged heading… */}
      <NewTestForm from={typeof from === "string" ? from : null} />
    </div>
  );
}
```

- [ ] **Step 6: Run the web suite, typecheck and build**

Run: `pnpm --filter @platform/web test && pnpm --filter @platform/web typecheck && pnpm --filter @platform/web build`
Expected: PASS; the build lists `/runs/new` as dynamic (it reads `searchParams`).

- [ ] **Step 7: Docs**

README.md — in the section describing the web UI / criteria review (search for "criteria review" or "Review the acceptance criteria"), replace the description of editing with:

```markdown
**Criteria review.** Each proposed criterion shows its wording and *what will be checked*. You can adjust a check's values — a number, a comparison, the text and how it matches, shown or not shown, a list item — or remove a criterion; the server then writes the criterion's wording from its check, so the report never shows wording that differs from what was verified. What a check reads (the element and moment) can't be changed in review, and AI-judged criteria can only be removed. For anything else use **Start over with a revised requirement**: it cancels the run and opens the new-test form with the website and requirement copied (test data and secrets must be entered again). `PUT /v1/test-runs/:runId/criteria` enforces the same rules for any client (400 `VALIDATION_FAILED` / `STATEMENT_ONLY_EDIT`).
```

and add to the README's deviations list (where Milestone C/D deviations are recorded): "Criteria review edits checks, not wording (spec `docs/superpowers/specs/2026-09-26-criteria-check-edit-design.md`): supersedes Ruling R55 and plan Task 11's statement-text edits."

`docs/ai-testing-platform-implementation-plan.md` — in Task 11, Step 1, after the `PUT` bullet add: "> Superseded in part by `docs/superpowers/specs/2026-09-26-criteria-check-edit-design.md`: statement text alone can no longer change; a check's values can, and the server writes the statement."

- [ ] **Step 8: Run every affected suite and the root typecheck**

Run: `pnpm --filter @platform/contracts test && pnpm --filter @platform/api test && pnpm --filter @platform/testing-engine test && pnpm --filter @platform/worker test && pnpm --filter @platform/web test && pnpm typecheck`
Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/web/components/CriteriaReview.tsx apps/web/components/CriteriaReview.test.tsx apps/web/components/NewTestForm.tsx apps/web/components/NewTestForm.test.tsx apps/web/app/runs/new/page.tsx README.md docs/ai-testing-platform-implementation-plan.md
git commit -m "feat: start over from criteria review with the requirement copied

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
