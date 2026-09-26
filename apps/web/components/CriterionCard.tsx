"use client";

import type { AcceptanceCriterion, FactRequest } from "@platform/contracts";
import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { describeOutcome } from "./outcome-text";

interface Props {
  criterion: AcceptanceCriterion;
  /** The requirement's fact descriptions, to name what the check reads. */
  facts: readonly FactRequest[];
  /** The statement differs from the one this review loaded with. */
  reworded: boolean;
  /** Another save is in flight: edits are paused. */
  busy: boolean;
  canRemove: boolean;
  onSave: (statement: string) => Promise<boolean>;
  onRemove: () => void;
  /** The editor opened (true) or closed (false); also false when the card goes away. */
  onEditingChange?: (editing: boolean) => void;
}

const PRECONDITION: Record<AcceptanceCriterion["preconditions"][number]["kind"], string> = {
  authenticated: "Needs a signed-in user",
  test_data: "Needs test data",
  secret: "Needs a secret",
};

export function CriterionCard({ criterion: c, facts, reworded, busy, canRemove, onSave, onRemove, onEditingChange }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(c.statement);
  const [error, setError] = useState<string | null>(null);
  // Cards are keyed by id, so saving another criterion keeps this card's draft; only a change to
  // its own statement (its own save) resets it.
  const [statement, setStatement] = useState(c.statement);
  if (statement !== c.statement) {
    setStatement(c.statement);
    setDraft(c.statement);
  }

  const reportEditing = useRef(onEditingChange);
  useEffect(() => {
    reportEditing.current = onEditingChange;
  });
  useEffect(() => {
    if (!editing) return;
    reportEditing.current?.(true);
    return () => reportEditing.current?.(false);
  }, [editing]);
  const aiJudged = c.expectedOutcome.kind === "semantic";
  const boxId = `criterion-${c.id}-statement`;

  async function save() {
    const text = draft.trim();
    if (text.length < 3 || text.length > 1000) {
      setError("Use 3 to 1000 characters.");
      return;
    }
    setError(null);
    if (await onSave(text)) setEditing(false);
  }

  return (
    <article className={`card criterion${c.ambiguity ? " criterion-unclear" : aiJudged ? " criterion-ai" : ""}`} aria-labelledby={`${c.id}-title`}>
      <header className="criterion-head">
        <h3 id={`${c.id}-title`} className="criterion-id">
          {c.id}
        </h3>
        <div className="badges">
          {c.ambiguity && (
            <span className="badge badge-warning">
              <Icon name="warning" /> Needs clarification
            </span>
          )}
          {aiJudged && (
            <span className="badge badge-info">
              <Icon name="info" /> AI-judged
            </span>
          )}
        </div>
      </header>

      {editing ? (
        <div className="field">
          <label htmlFor={boxId} className="visually-hidden">
            Criterion {c.id}
          </label>
          <textarea
            id={boxId}
            rows={3}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${boxId}-error` : undefined}
            autoFocus
            onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
          />
          {error && (
            <p id={`${boxId}-error`} className="field-error">
              <Icon name="error" /> {error}
            </p>
          )}
          <div className="actions">
            <button type="button" className="button button-primary" onClick={save} disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              className="button button-quiet"
              onClick={() => {
                setEditing(false);
                setDraft(c.statement);
                setError(null);
              }}
              disabled={busy}
            >
              Discard
            </button>
          </div>
        </div>
      ) : (
        <p className="criterion-statement">{c.statement}</p>
      )}

      <div className="criterion-check" role="group" aria-labelledby={`${c.id}-check`}>
        <p id={`${c.id}-check`} className="criterion-check-title">
          What will be checked
        </p>
        <p>{describeOutcome(c.expectedOutcome, facts)}</p>
        {(editing || reworded) && (
          <p className="hint">
            <Icon name="info" /> Rewording changes the description only; the check above is unchanged.
          </p>
        )}
      </div>

      <p className="criterion-source">
        From your requirement: <q>{c.sourceText}</q>
      </p>

      {c.preconditions.length > 0 && (
        <ul className="criterion-needs">
          {c.preconditions.map((p, i) => (
            <li key={i}>
              {PRECONDITION[p.kind]}
              {p.ref ? `: ${p.ref}` : ""}
            </li>
          ))}
        </ul>
      )}

      {c.ambiguity && (
        <div className="note note-warning">
          <p className="note-title">Why it is unclear</p>
          <p>{c.ambiguity.reason}</p>
          {c.ambiguity.suggestions.length > 0 && (
            <>
              <p className="note-title">Suggested wording</p>
              <ul>
                {c.ambiguity.suggestions.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      {aiJudged && (
        <div className="note note-info">
          <p>
            Only a model can judge this, so it will be reported as <strong>Inconclusive</strong>; the model&apos;s opinion is shown as a
            note, never as a result.
          </p>
        </div>
      )}

      {!editing && (
        <div className="actions">
          <button
            type="button"
            className="button button-secondary"
            onClick={() => {
              setDraft(c.statement);
              setEditing(true);
            }}
            disabled={busy}
            aria-label={`Edit ${c.id}`}
          >
            Edit
          </button>
          <button
            type="button"
            className="button button-quiet"
            onClick={onRemove}
            disabled={busy || !canRemove}
            title={canRemove ? undefined : "At least one criterion is required"}
            aria-label={`Remove ${c.id}`}
          >
            Remove
          </button>
        </div>
      )}
    </article>
  );
}
