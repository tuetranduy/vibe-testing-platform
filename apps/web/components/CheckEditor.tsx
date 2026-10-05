"use client";

import { describeExpectedOutcome, type ExpectedOutcome, type FactRequest } from "@platform/contracts";
import { useEffect, useId, useRef, useState } from "react";
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

type Field = "number" | "text";

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
      return { ...d, mode: o.match.mode, text: o.match.value ?? "", caseSensitive: o.match.caseSensitive };
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
/** Compiled the way the verifier compiles it. */
const compiles = (pattern: string, caseSensitive: boolean) => {
  try {
    new RegExp(pattern, caseSensitive ? "" : "i");
    return true;
  } catch {
    return false;
  }
};

/** The edited check, or the field errors that stop it (mirrors the contract and the API's rules). */
function build(o: EditableOutcome, d: Draft): { outcome: ExpectedOutcome } | { errors: Partial<Record<Field, string>> } {
  switch (o.kind) {
    case "visible":
      return { outcome: { ...o, expected: d.expected } };
    case "text_matches":
      // Against a test data value (KI-001): the key stays; a pattern is always written out, so no regex.
      if (o.match.testDataKey !== undefined) {
        const mode = d.mode === "regex" ? "contains" : d.mode;
        return { outcome: { ...o, match: { mode, testDataKey: o.match.testDataKey, caseSensitive: d.caseSensitive } } };
      }
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
  const root = useRef<HTMLDivElement>(null);
  // The "Edit check" button that opened the editor is gone now: start on the first control.
  useEffect(() => {
    root.current?.querySelector<HTMLElement>("input, select, textarea, button")?.focus();
  }, []);
  const [draft, setDraft] = useState<Draft>(() => draftOf(outcome));
  const [shown, setShown] = useState<Partial<Record<Field, string>>>({});
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const built = build(outcome, draft);
  const id = (name: string) => `${uid}-${name}`;

  function save() {
    if ("errors" in built) {
      setShown(built.errors);
      return;
    }
    setShown({});
    onSave(built.outcome);
  }

  // Numbers use the default (text) keyboard: iOS's "decimal" keypad has no minus key.
  const input = (field: Field, label: string, value: string, onChange: (v: string) => void) => (
    <div className="field">
      <label htmlFor={id(field)}>{label}</label>
      <input
        id={id(field)}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={shown[field] ? true : undefined}
        aria-describedby={shown[field] ? id(`${field}-error`) : undefined}
      />
      {shown[field] && (
        <p id={id(`${field}-error`)} className="field-error">
          <Icon name="error" /> {shown[field]}
        </p>
      )}
    </div>
  );
  const numberField = (label: string) => input("number", label, draft.number, (v) => set({ number: v }));
  const textField = (label: string) => input("text", label, draft.text, (v) => set({ text: v }));

  return (
    <div ref={root} className="check-editor stack" role="group" aria-label={`Edit the check of ${criterionId}`}>
      {outcome.kind === "visible" && (
        <fieldset className="field">
          <legend>The element should be</legend>
          <div className="choice-row">
            <label className="choice">
              <input type="radio" name={id("visible")} checked={draft.expected} onChange={() => set({ expected: true })} />
              Shown
            </label>
            <label className="choice">
              <input type="radio" name={id("visible")} checked={!draft.expected} onChange={() => set({ expected: false })} />
              Not shown
            </label>
          </div>
        </fieldset>
      )}

      {outcome.kind === "text_matches" && (
        <>
          <div className="field">
            <label htmlFor={id("mode")}>How it matches</label>
            <select id={id("mode")} value={draft.mode} onChange={(e) => set({ mode: e.target.value as Draft["mode"] })}>
              <option value="contains">Contains</option>
              <option value="equals">Is exactly</option>
              {outcome.match.testDataKey === undefined && <option value="regex">Matches the pattern</option>}
            </select>
          </div>
          {outcome.match.testDataKey === undefined ? (
            textField(draft.mode === "regex" ? "Pattern" : "Text")
          ) : (
            <p className="hint">
              Compared with the test data value <strong>{outcome.match.testDataKey}</strong>
            </p>
          )}
          <label className="choice">
            <input type="checkbox" checked={draft.caseSensitive} onChange={(e) => set({ caseSensitive: e.target.checked })} />
            Match case
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
