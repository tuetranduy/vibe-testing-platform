"use client";

import { describeExpectedOutcome, type AcceptanceCriterion, type ExpectedOutcome, type FactRequest, type SiteCheck } from "@platform/contracts";
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
  /**
   * Marks the criterion critical or not (V1.1); resolves to null when saved, or the error to show. Absent: no
   * switch. `canMakeNonCritical: false` (the last critical criterion) keeps it on.
   */
  onCriticalChange?: (critical: boolean) => Promise<string | null>;
  canMakeNonCritical?: boolean;
  /** The editor opened (true) or closed (false); also false when the card goes away. */
  onEditingChange?: (editing: boolean) => void;
  /** What the live site showed for this criterion (V1.3); absent: no pages were read. */
  siteCheck?: SiteCheck | undefined;
}

const SITE_CHECK: Record<SiteCheck["status"], { label: string; className: string; icon: "check" | "warning" | "info" }> = {
  FOUND: { label: "Seen on the site", className: "site-check site-check-found", icon: "check" },
  NOT_FOUND: { label: "Not found on the pages read", className: "site-check site-check-missing", icon: "warning" },
  UNCLEAR: { label: "Unclear from the pages read", className: "site-check", icon: "info" },
};

/** JSON with object keys sorted (and JSON's number form: 1.0 → 1, -0 → 0), to tell whether a check changed. */
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

const PRECONDITION: Record<AcceptanceCriterion["preconditions"][number]["kind"], string> = {
  authenticated: "Needs a signed-in user",
  test_data: "Needs test data",
  secret: "Needs a secret",
};

export function CriterionCard({
  criterion: c,
  facts,
  busy,
  canRemove,
  onSave,
  onRemove,
  onCriticalChange,
  canMakeNonCritical = true,
  onEditingChange,
  siteCheck,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [weightError, setWeightError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  // When the editor closes, its buttons disappear: give focus back to "Edit check".
  const editButton = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  useEffect(() => {
    if (wasEditing.current && !editing) editButton.current?.focus();
    wasEditing.current = editing;
  }, [editing]);
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
      <h3 id={`${c.id}-title`} className="criterion-id">
        {c.id}
      </h3>
      <div className="criterion-body">
        {(c.ambiguity || aiJudged) && (
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
        )}

        <p className="criterion-statement">{c.statement}</p>

        <div className="criterion-check" role="group" aria-labelledby={`${c.id}-check`}>
          <p id={`${c.id}-check`} className="criterion-check-title">
            What will be checked
          </p>
          <p>{describeExpectedOutcome(c.expectedOutcome, facts)}</p>
        </div>

        {siteCheck && (
          <p className={SITE_CHECK[siteCheck.status].className}>
            <Icon name={SITE_CHECK[siteCheck.status].icon} />
            <span>
              <strong>{SITE_CHECK[siteCheck.status].label}:</strong> {siteCheck.note}
            </span>
          </p>
        )}

        {editing && c.expectedOutcome.kind !== "semantic" && (
          <CheckEditor
            criterionId={c.id}
            outcome={c.expectedOutcome}
            facts={facts}
            busy={busy}
            serverError={serverError}
            onSave={async (outcome) => {
              // Nothing changed: nothing to save (the API would refuse a wording-only revision).
              if (canonical(outcome) === canonical(c.expectedOutcome)) {
                setEditing(false);
                setServerError(null);
                return;
              }
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

        {onCriticalChange && (
          <div className="weight-field">
            <label className="choice">
              <input
                type="checkbox"
                checked={c.critical}
                disabled={busy || (c.critical && !canMakeNonCritical)}
                aria-describedby={`${c.id}-weight-hint`}
                onChange={async (e) => setWeightError(await onCriticalChange(e.target.checked))}
              />
              <span>Critical</span>
            </label>
            <p id={`${c.id}-weight-hint`} className="hint">
              {c.critical
                ? canMakeNonCritical
                  ? "Decides the verdict. Untick for a nice-to-have that is reported but never fails the run."
                  : "Decides the verdict. At least one criterion must stay critical."
                : "Non-critical: reported with its result, but the verdict ignores it."}
            </p>
            {weightError && (
              <p role="alert" className="field-error">
                <Icon name="error" /> {weightError}
              </p>
            )}
          </div>
        )}

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
              No exact value can check this, so AI judges it from what the page actually shows during the test (its text and a
              screenshot): <strong>Pass</strong> or <strong>Fail</strong> by its judgment, or <strong>Inconclusive</strong> when the page
              cannot decide it.
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
              <button
                ref={editButton}
                type="button"
                className="button button-secondary"
                onClick={() => setEditing(true)}
                disabled={busy}
                aria-label={`Edit check ${c.id}`}
              >
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
      </div>
    </article>
  );
}
