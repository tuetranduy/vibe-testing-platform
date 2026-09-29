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

/** Compiled the way the verifier compiles it (compileRegex in the testing engine). */
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
 * criteria may be removed (with the facts no remaining criterion reads), and a criterion's check
 * may change its literal values. For an edited criterion the server writes the statement from the
 * check and clears `ambiguity`, so the wording can never describe a different check than the one
 * the verifier runs. `critical` (V1.1) may change on any criterion, alone or with its check; it never
 * changes the wording. Anything else is rejected. Unedited criteria are returned exactly as in the
 * latest revision (with their weight as sent).
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
      criteria.push({
        ...before,
        critical: c.critical,
        expectedOutcome: outcome,
        statement: describeExpectedOutcome(outcome, body.facts),
        ambiguity: null,
      });
      return;
    }
    if (c.statement !== before.statement) wordingOnly.push({ path: at("statement"), message: "Change the check, not only its wording" });
    if (!same(c.ambiguity, before.ambiguity)) invalid.push({ path: at("ambiguity"), message: "ambiguity changes only with the check" });
    criteria.push({ ...before, critical: c.critical });
  });

  if (invalid.length > 0) return { ok: false, code: "VALIDATION_FAILED", issues: invalid };
  if (wordingOnly.length > 0) return { ok: false, code: "STATEMENT_ONLY_EDIT", issues: wordingOnly };
  return { ok: true, criteria, facts: body.facts };
}
