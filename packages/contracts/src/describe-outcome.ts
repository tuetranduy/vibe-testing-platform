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
      const { mode, value, testDataKey, caseSensitive } = outcome.match;
      const how = mode === "equals" ? "is exactly" : mode === "contains" ? "contains" : "matches the pattern";
      const what = testDataKey !== undefined ? `the test data value ${quoted(testDataKey)}` : quoted(value ?? "");
      return `${fact(outcome.fact)} ${how} ${what} (${caseSensitive ? "case-sensitive" : "ignoring case"}).`;
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
