import type { FactValue } from "@platform/contracts";

/**
 * Pure fact-value normalization shared by the fact reader (Task 14: does the model's value equal the
 * DOM reading?) and the verifier (Task 15: does the recorded value satisfy the rule?). No I/O.
 */

const NUMBER_TOKEN = /-?\d(?:[\d.,'’  ]*\d)?/;

/** First number in a text: handles `1,299.50`, `1'299.00`, `1.234,56`, `12,5`. Null if none. */
export function parseNumber(text: string): number | null {
  const m = NUMBER_TOKEN.exec(text);
  if (!m) return null;
  let token = m[0].replace(/['’  ]/g, "");
  const lastDot = token.lastIndexOf(".");
  const lastComma = token.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) {
    // Both present: the later one is the decimal separator.
    token = lastComma > lastDot ? token.replace(/\./g, "").replace(",", ".") : token.replace(/,/g, "");
  } else if (lastComma >= 0) {
    // Only commas: thousands groups (1,000 / 1,299,000) or a decimal comma (12,5).
    token = /^-?\d{1,3}(,\d{3})+$/.test(token) ? token.replace(/,/g, "") : token.replace(/,/g, ".");
  } else if ((token.match(/\./g) ?? []).length > 1) {
    token = token.replace(/\./g, ""); // 1.234.567
  }
  const n = Number(token);
  return Number.isFinite(n) ? n : null;
}

/** NFKC, whitespace collapsed and trimmed (case kept). */
export const collapseText = (s: string): string => s.normalize("NFKC").replace(/\s+/g, " ").trim();

/** `collapseText`, lower-cased: case- and whitespace-insensitive comparison key. */
export const foldText = (s: string): string => collapseText(s).toLowerCase();

/** A boolean, or a "true"/"yes"/"false"/"no" string; else null. */
export function asBoolean(v: FactValue): boolean | null {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = foldText(v);
    if (s === "true" || s === "yes") return true;
    if (s === "false" || s === "no") return false;
  }
  return null;
}

/** A finite number, or the first number in a string (`"Cart (3)"` → 3); else null. */
export function asNumber(v: FactValue): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") return parseNumber(v);
  return null;
}

/** Numeric equality with a tolerance for binary floating point. */
export const numbersEqual = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;

/** Whether the model's value equals the DOM reading after normalization (typed by the DOM value). */
export function factValuesEqual(modelValue: FactValue, domValue: FactValue): boolean {
  if (domValue === null || modelValue === null) return domValue === null && modelValue === null;
  if (Array.isArray(domValue)) {
    return (
      Array.isArray(modelValue) &&
      modelValue.length === domValue.length &&
      modelValue.every((item, i) => foldText(item) === foldText(domValue[i]!))
    );
  }
  if (Array.isArray(modelValue)) return false;
  if (typeof domValue === "number") {
    const n = asNumber(modelValue);
    return n !== null && numbersEqual(n, domValue);
  }
  if (typeof domValue === "boolean") return asBoolean(modelValue) === domValue;
  return foldText(String(modelValue)) === foldText(domValue);
}
