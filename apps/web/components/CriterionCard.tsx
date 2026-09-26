"use client";

import { describeExpectedOutcome, type AcceptanceCriterion, type ExpectedOutcome, type FactRequest } from "@platform/contracts";
import { useEffect, useRef, useState } from "react";
import { CheckEditor } from "./CheckEditor";
import { Icon } from "./Icon";

interface Props {
  criterion: AcceptanceCriterion;
  /** The requirement's fact descriptions, to name what the check reads. */
  facts: readonly FactRequest[];
  /** Another save is in flight: edits are paused. */
  busy: boolean;
  canRemove: boolean;
  /** Saves an edited check; resolves to null when saved, or the error to show in the editor. */
  onSave: (outcome: ExpectedOutcome) => Promise<string | null>;
  onRemove: () => void;
  /** The editor opened (true) or closed (false); also false when the card goes away. */
  onEditingChange?: (editing: boolean) => void;
}

const PRECONDITION: Record<AcceptanceCriterion["preconditions"][number]["kind"], string> = {
  authenticated: "Needs a signed-in user",
  test_data: "Needs test data",
  secret: "Needs a secret",
};

export function CriterionCard({ criterion: c, facts, busy, canRemove, onSave, onRemove, onEditingChange }: Props) {
  const [editing, setEditing] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  // Cards are keyed by id, so saving another criterion keeps this card's open editor; only a
  // change to its own check (its own save) closes it.
  const checkKey = JSON.stringify(c.expectedOutcome);
  const [seenCheck, setSeenCheck] = useState(checkKey);
  if (seenCheck !== checkKey) {
    setSeenCheck(checkKey);
    setEditing(false);
    setServerError(null);
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

      <p className="criterion-statement">{c.statement}</p>

      <div className="criterion-check" role="group" aria-labelledby={`${c.id}-check`}>
        <p id={`${c.id}-check`} className="criterion-check-title">
          What will be checked
        </p>
        <p>{describeExpectedOutcome(c.expectedOutcome, facts)}</p>
      </div>

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
                {c.ambiguity.suggestions.map((s, i) => (
                  <li key={`${i}-${s}`}>{s}</li>
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
          <p>Judged by AI only — it can only be removed.</p>
        </div>
      )}

      {!editing && removing && (
        <div role="group" aria-labelledby={`${c.id}-remove-title`} className="note note-warning">
          <p id={`${c.id}-remove-title`} className="note-title">
            Remove {c.id}?
          </p>
          <p>It won&apos;t be checked in this run.</p>
          <div className="actions">
            <button
              type="button"
              className="button button-danger"
              onClick={() => {
                setRemoving(false);
                onRemove();
              }}
              disabled={busy}
            >
              Yes, remove
            </button>
            <button type="button" className="button button-secondary" onClick={() => setRemoving(false)} autoFocus>
              Keep it
            </button>
          </div>
        </div>
      )}

      {!editing && !removing && (
        <div className="actions">
          {!aiJudged && (
            <button type="button" className="button button-secondary" onClick={() => setEditing(true)} disabled={busy} aria-label={`Edit check ${c.id}`}>
              Edit check
            </button>
          )}
          <button
            type="button"
            className="button button-quiet"
            onClick={() => setRemoving(true)}
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
