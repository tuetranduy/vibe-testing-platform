import type { FactValue } from "@platform/contracts";
import { asNumber, collapseText, foldText, numbersEqual } from "../shared/fact-values";

/**
 * Value normalization for the verifier (pure). Comparisons are over normalized text:
 * - every string compare trims and collapses whitespace (NFKC);
 * - `text_matches` honours `caseSensitive` for equals / contains / regex;
 * - `collection_contains` in `contains` mode is case- and whitespace-insensitive; in `equals` mode it
 *   compares whole items after whitespace normalization, case kept.
 * A value of the wrong type for a rule reads as null here (no coercion between types, except a string
 * that is wholly a number for numeric rules), and the verifier reports it as not observed.
 */

export { collapseText, foldText, numbersEqual };

/** Upper bound for expected / actual strings (ProvisionalResultSchema). */
export const MAX_RESULT_TEXT = 1000;

/** The longest regex pattern accepted (TextMatchSchema already bounds `value` to 500). */
export const MAX_REGEX_LENGTH = 500;

const WHOLE_NUMBER = /^-?\d(?:[\d.,'’  ]*\d)?$/;

/**
 * A finite number, or a text that is wholly a number (`" 1,299.50 "` → 1299.5). Text around a number
 * (`"iPhone 17 Pro"`, `"Cart (3)"`) is the wrong type, not a number: the DOM `number` read already
 * extracts the number, so a string here means the fact was not read as a number. Null / booleans /
 * lists → null.
 */
export function numberOf(v: FactValue): number | null {
  if (typeof v === "string" && !WHOLE_NUMBER.test(collapseText(v))) return null;
  return asNumber(v);
}

/**
 * A boolean. Anything else → null: no coercion of "yes"/"true" strings or numbers, since a value of
 * the wrong type for the rule is not observed (INCONCLUSIVE), never evidence for PASS/FAIL.
 */
export function booleanOf(v: FactValue): boolean | null {
  return typeof v === "boolean" ? v : null;
}

/**
 * A string. Anything else → null: a number is not coerced to text (a number fact read as 1299 must
 * not FAIL "equals '1,299.00'"); the wrong type is not observed (INCONCLUSIVE), never FAIL.
 */
export function textOf(v: FactValue): string | null {
  return typeof v === "string" ? v : null;
}

/** A list of strings. Anything else → null. */
export function listOf(v: FactValue): string[] | null {
  return Array.isArray(v) ? v : null;
}

const key = (s: string, caseSensitive: boolean) => (caseSensitive ? collapseText(s) : foldText(s));

export function textEquals(actual: string, expected: string, caseSensitive: boolean): boolean {
  return key(actual, caseSensitive) === key(expected, caseSensitive);
}

export function textContains(actual: string, expected: string, caseSensitive: boolean): boolean {
  return key(actual, caseSensitive).includes(key(expected, caseSensitive));
}

/**
 * Compiles a criterion's regex, or returns null when it is invalid or too long (the verifier then
 * reports the criterion as ambiguous instead of crashing). No `u` flag: patterns are written for the
 * classic syntax. Patterns are bounded and come from the confirmed criteria, not from the page.
 */
export function compileRegex(pattern: string, caseSensitive: boolean): RegExp | null {
  if (pattern.length > MAX_REGEX_LENGTH) return null;
  try {
    return new RegExp(pattern, caseSensitive ? "" : "i");
  } catch {
    return null;
  }
}

/** Regex test over whitespace-collapsed text, the same text the DOM reader records. */
export function textMatchesRegex(actual: string, regex: RegExp): boolean {
  return regex.test(collapseText(actual));
}

/** Truncates to `max` characters, marking the cut with an ellipsis. */
export function clip(s: string, max = MAX_RESULT_TEXT): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
