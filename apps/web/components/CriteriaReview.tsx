"use client";

import { describeExpectedOutcome, type NormalizedRequirement } from "@platform/contracts";
import { useCallback, useEffect, useState } from "react";
import { ApiRequestError, confirmCriteria, getCriteria, updateCriteria, type ConfirmResult } from "../lib/api";
import { CriterionCard } from "./CriterionCard";
import { Icon } from "./Icon";

interface Props {
  runId: string;
  /** Called once the server has frozen the criteria and queued the run. */
  onConfirmed: (result: ConfirmResult) => void;
}

/** "AC-2" / "AC-1 and AC-2" / "AC-1, AC-2 and AC-3" */
const listIds = (ids: string[]) => (ids.length <= 1 ? ids.join("") : `${ids.slice(0, -1).join(", ")} and ${ids.at(-1)}`);

const messageOf = (err: unknown) => (err instanceof ApiRequestError ? err.message : "Something went wrong. Please try again.");

export function CriteriaReview({ runId, onConfirmed }: Props) {
  const [requirement, setRequirement] = useState<NormalizedRequirement | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Criteria whose editor is open: confirming would freeze the old text, so it waits for them. */
  const [editing, setEditing] = useState<ReadonlySet<string>>(new Set());
  const editingChange = useCallback(
    (id: string, open: boolean) =>
      setEditing((prev) => {
        if (prev.has(id) === open) return prev;
        const next = new Set(prev);
        if (open) next.add(id);
        else next.delete(id);
        return next;
      }),
    [],
  );

  useEffect(() => {
    let live = true;
    getCriteria(runId).then(
      (r) => live && setRequirement(r),
      (err: unknown) => live && setLoadError(messageOf(err)),
    );
    return () => {
      live = false;
    };
  }, [runId]);

  /**
   * Saves the full requirement with `criteria` replaced (the API takes whole revisions); resolves
   * to null, or the error to show (the API's per-field issues when it gives them).
   */
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

  async function confirm() {
    setConfirming(true);
    setError(null);
    try {
      onConfirmed(await confirmCriteria(runId));
    } catch (err) {
      setError(messageOf(err));
      setConfirming(false);
    }
  }

  if (loadError) {
    return (
      <div role="alert" className="banner banner-error">
        <Icon name="warning" />
        <div>
          <p className="banner-title">The criteria couldn&apos;t be loaded</p>
          <p>{loadError}</p>
        </div>
      </div>
    );
  }
  if (!requirement) {
    return (
      <p className="muted" role="status">
        Loading criteria…
      </p>
    );
  }

  const { criteria } = requirement;
  const unclear = criteria.filter((c) => c.ambiguity !== null).length;
  const aiJudged = criteria.filter((c) => c.expectedOutcome.kind === "semantic").length;
  const openEdits = criteria.map((c) => c.id).filter((id) => editing.has(id));

  return (
    <section className="stack" aria-labelledby="review-title">
      <div className="section-head">
        <h2 id="review-title">Review the acceptance criteria</h2>
        <p className="muted">
          These are what the run will check. Adjust a check&apos;s values or remove a criterion — they&apos;re frozen once you confirm. Revision{" "}
          {requirement.revision}.
        </p>
        <p className="summary-line">
          {criteria.length} {criteria.length === 1 ? "criterion" : "criteria"}
          {unclear > 0 && ` · ${unclear} unclear`}
          {aiJudged > 0 && ` · ${aiJudged} judged by a model only`}
        </p>
      </div>

      {error && (
        <div role="alert" className="banner banner-error">
          <Icon name="warning" />
          <div>
            <p className="banner-title">That didn&apos;t work</p>
            <p>{error}</p>
          </div>
        </div>
      )}

      <div className="criteria-list">
        {criteria.map((c) => (
          <CriterionCard
            key={c.id}
            criterion={c}
            facts={requirement.facts}
            busy={saving || confirming}
            canRemove={criteria.length > 1}
            onSave={(outcome) =>
              save(
                criteria.map((x) =>
                  x.id === c.id
                    ? { ...x, expectedOutcome: outcome, statement: describeExpectedOutcome(outcome, requirement.facts), ambiguity: null }
                    : x,
                ),
              )
            }
            onRemove={() => void save(criteria.filter((x) => x.id !== c.id)).then((err) => err && setError(err))}
            onEditingChange={(open) => editingChange(c.id, open)}
          />
        ))}
      </div>

      <div className="form-actions">
        <button
          type="button"
          className="button button-primary"
          onClick={confirm}
          disabled={confirming || saving || openEdits.length > 0}
          aria-describedby={openEdits.length > 0 ? "confirm-blocked" : undefined}
        >
          {confirming ? "Starting…" : "Confirm and start"}
        </button>
        {openEdits.length > 0 && (
          <p id="confirm-blocked" className="hint">
            <Icon name="info" /> Save or discard your {openEdits.length === 1 ? "edit" : "edits"} to {listIds(openEdits)} first.
          </p>
        )}
        {(unclear > 0 || aiJudged > 0) && (
          <p className="hint">
            <Icon name="info" /> Unclear and model-judged criteria will be reported as Inconclusive.
          </p>
        )}
      </div>
    </section>
  );
}
