import { URL_FACT_KEY, type ExpectedOutcome, type FactRef, type FactValue } from "@platform/contracts";
import {
  booleanOf,
  collapseText,
  compileRegex,
  foldText,
  listOf,
  numberOf,
  numbersEqual,
  textContains,
  textEquals,
  textMatchesRegex,
  textOf,
} from "./normalize";

/**
 * Deterministic rules (pure): one per `ExpectedOutcome` kind except `semantic`, which no rule can
 * decide (D3). Every human-readable string here is template-built from fact keys, checkpoints,
 * operators and recorded values — never from model prose.
 */

export type DeterministicOutcome = Exclude<ExpectedOutcome, { kind: "semantic" }>;

export type RuleResult =
  | { status: "PASS" | "FAIL"; reason: null; actual: string }
  | { status: "INCONCLUSIVE"; reason: "FACT_NOT_OBSERVED" | "AMBIGUOUS_CRITERION"; actual: string };

// --- labels --------------------------------------------------------------------------------------

/** `cartCount` → "Cart count"; the reserved `url` → "URL". */
export function humanizeKey(key: string): string {
  if (key === URL_FACT_KEY) return "URL";
  const words = key.replace(/_/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const checkpointLabel = (checkpoint: string) => checkpoint.replace(/_/g, " ");

/** "Cart count after add". */
export const factLabel = (ref: FactRef): string => `${humanizeKey(ref.key)} ${checkpointLabel(ref.checkpoint)}`;

/** A second fact in the same sentence: just its checkpoint when it has the first one's key. */
const otherLabel = (ref: FactRef, first: FactRef) => (ref.key === first.key ? checkpointLabel(ref.checkpoint) : factLabel(ref));

const OPERATOR = { eq: "=", neq: "!=", gt: ">", gte: ">=", lt: "<", lte: "<=" } as const;
type Operator = keyof typeof OPERATOR;

const num = (n: number) => String(Number(n.toPrecision(12)));
const signed = (n: number) => (n > 0 ? `+${num(n)}` : num(n));
const quoted = (s: string) => JSON.stringify(collapseText(s));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// --- expected ------------------------------------------------------------------------------------

/** The expected side of a criterion, as a template-built sentence. */
export function describeExpected(outcome: ExpectedOutcome): string {
  switch (outcome.kind) {
    case "numeric_compare": {
      const right = typeof outcome.right === "number" ? num(outcome.right) : otherLabel(outcome.right, outcome.left);
      return `${factLabel(outcome.left)} ${OPERATOR[outcome.operator]} ${right}`;
    }
    case "numeric_delta":
      return `${factLabel(outcome.after)} - ${otherLabel(outcome.before, outcome.after)} = ${signed(outcome.delta)}`;
    case "collection_contains": {
      const item = typeof outcome.item === "string" ? quoted(outcome.item) : factLabel(outcome.item);
      return `${factLabel(outcome.collection)} has an item ${outcome.match === "equals" ? "equal to" : "containing"} ${item}`;
    }
    case "text_matches": {
      const { mode, caseSensitive } = outcome.match;
      // A test data key is resolved to its value before a check is evaluated (resolveTestDataValues).
      const value = outcome.match.testDataKey !== undefined ? `the test data value ${quoted(outcome.match.testDataKey)}` : null;
      const literal = outcome.match.value ?? "";
      const what =
        mode === "equals" ? `equals ${value ?? quoted(literal)}` : mode === "contains" ? `contains ${value ?? quoted(literal)}` : `matches /${literal}/`;
      return `${factLabel(outcome.fact)} ${what}${caseSensitive ? " (case-sensitive)" : ""}`;
    }
    case "visible":
      return `${factLabel(outcome.fact)} is ${outcome.expected ? "" : "not "}visible`;
    case "semantic":
      return outcome.description;
  }
}

// --- evaluation ----------------------------------------------------------------------------------

const notObserved = (ref: FactRef, value: FactValue, what: string): RuleResult => ({
  status: "INCONCLUSIVE",
  reason: "FACT_NOT_OBSERVED",
  actual: `${factLabel(ref)} was read as ${JSON.stringify(value)}, not ${what}`,
});

const decided = (pass: boolean, actual: string): RuleResult => ({ status: pass ? "PASS" : "FAIL", reason: null, actual });

function compare(left: number, operator: Operator, right: number): boolean {
  switch (operator) {
    case "eq":
      return numbersEqual(left, right);
    case "neq":
      return !numbersEqual(left, right);
    case "gt":
      return left > right && !numbersEqual(left, right);
    case "gte":
      return left > right || numbersEqual(left, right);
    case "lt":
      return left < right && !numbersEqual(left, right);
    case "lte":
      return left < right || numbersEqual(left, right);
  }
}

/**
 * Evaluates a deterministic outcome over recorded values. `valueOf` must return the value of every
 * FactRef the outcome uses (the verifier has already checked they were recorded). A value of the
 * wrong type is not observed (never FAIL); an invalid regex makes the criterion ambiguous.
 */
export function evaluateRule(outcome: DeterministicOutcome, valueOf: (ref: FactRef) => FactValue): RuleResult {
  switch (outcome.kind) {
    case "numeric_compare": {
      const lv = valueOf(outcome.left);
      const left = numberOf(lv);
      if (left === null) return notObserved(outcome.left, lv, "a number");
      let right: number;
      let rightText: string;
      if (typeof outcome.right === "number") {
        right = outcome.right;
        rightText = num(right);
      } else {
        const rv = valueOf(outcome.right);
        const n = numberOf(rv);
        if (n === null) return notObserved(outcome.right, rv, "a number");
        right = n;
        rightText = `${otherLabel(outcome.right, outcome.left)} (${num(n)})`;
      }
      const pass = compare(left, outcome.operator, right);
      const op = OPERATOR[outcome.operator];
      return decided(pass, `${factLabel(outcome.left)} (${num(left)}) ${pass ? op : `is not ${op}`} ${rightText}`);
    }

    case "numeric_delta": {
      const bv = valueOf(outcome.before);
      const b = numberOf(bv);
      if (b === null) return notObserved(outcome.before, bv, "a number");
      const av = valueOf(outcome.after);
      const a = numberOf(av);
      if (a === null) return notObserved(outcome.after, av, "a number");
      const change = a - b;
      const pass = numbersEqual(change, outcome.delta);
      const sentence = `${factLabel(outcome.after)} (${num(a)}) - ${otherLabel(outcome.before, outcome.after)} (${num(b)}) = ${signed(change)}`;
      return decided(pass, pass ? sentence : `${sentence}, not ${signed(outcome.delta)}`);
    }

    case "collection_contains": {
      const cv = valueOf(outcome.collection);
      const list = listOf(cv);
      if (list === null) return notObserved(outcome.collection, cv, "a list");
      let item: string;
      let itemNote = "";
      if (typeof outcome.item === "string") {
        item = outcome.item;
      } else {
        const iv = valueOf(outcome.item);
        const t = textOf(iv);
        if (t === null) return notObserved(outcome.item, iv, "text");
        item = t;
        itemNote = `; ${factLabel(outcome.item)} is ${quoted(t)}`;
      }
      const pass =
        outcome.match === "equals"
          ? list.some((entry) => collapseText(entry) === collapseText(item))
          : list.some((entry) => foldText(entry).includes(foldText(item)));
      return decided(pass, `${factLabel(outcome.collection)} (${plural(list.length, "item")}): ${JSON.stringify(list)}${itemNote}`);
    }

    case "text_matches": {
      const { mode, caseSensitive } = outcome.match;
      const value = outcome.match.value;
      // The verifier blocks a check whose test data key is unresolved before it gets here.
      if (value === undefined) throw new Error("text_matches: a test data key must be resolved before the check is evaluated");
      const regex = mode === "regex" ? compileRegex(value, caseSensitive) : null;
      if (mode === "regex" && regex === null) {
        return { status: "INCONCLUSIVE", reason: "AMBIGUOUS_CRITERION", actual: "The criterion's regular expression is invalid" };
      }
      const tv = valueOf(outcome.fact);
      const text = textOf(tv);
      if (text === null) return notObserved(outcome.fact, tv, "text");
      const pass =
        mode === "equals"
          ? textEquals(text, value, caseSensitive)
          : mode === "contains"
            ? textContains(text, value, caseSensitive)
            : textMatchesRegex(text, regex!);
      return decided(pass, `${factLabel(outcome.fact)} is ${quoted(text)}`);
    }

    case "visible": {
      const vv = valueOf(outcome.fact);
      const visible = booleanOf(vv);
      if (visible === null) return notObserved(outcome.fact, vv, "true or false");
      return decided(visible === outcome.expected, `${factLabel(outcome.fact)} is ${visible ? "" : "not "}visible`);
    }
  }
}
