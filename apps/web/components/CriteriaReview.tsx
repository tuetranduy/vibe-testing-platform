"use client";

import type { NormalizedRequirement } from "@platform/contracts";
import { useEffect, useState } from "react";
import { ApiRequestError, confirmCriteria, getCriteria, updateCriteria, type ConfirmResult } from "../lib/api";
import { CriterionCard } from "./CriterionCard";
import { Icon } from "./Icon";

interface Props {
  runId: string;
  /** Called once the server has frozen the criteria and queued the run. */
  onConfirmed: (result: ConfirmResult) => void;
}

const messageOf = (err: unknown) => (err instanceof ApiRequestError ? err.message : "Something went wrong. Please try again.");

export function CriteriaReview({ runId, onConfirmed }: Props) {
  const [requirement, setRequirement] = useState<NormalizedRequirement | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  /** Saves the full requirement with `criteria` replaced (the API takes whole revisions). */
  async function save(criteria: NormalizedRequirement["criteria"]): Promise<boolean> {
    if (!requirement) return false;
    setSaving(true);
    setError(null);
    try {
      setRequirement(await updateCriteria(runId, { ...requirement, criteria }));
      return true;
    } catch (err) {
      setError(messageOf(err));
      return false;
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

  return (
    <section className="stack" aria-labelledby="review-title">
      <div className="section-head">
        <h2 id="review-title">Review the acceptance criteria</h2>
        <p className="muted">
          These are what the run will check. Edit or remove any that are wrong — they&apos;re frozen once you confirm. Revision{" "}
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
            key={`${c.id}-${requirement.revision}`}
            criterion={c}
            busy={saving || confirming}
            canRemove={criteria.length > 1}
            onSave={(statement) => save(criteria.map((x) => (x.id === c.id ? { ...x, statement } : x)))}
            onRemove={() => void save(criteria.filter((x) => x.id !== c.id))}
          />
        ))}
      </div>

      <div className="form-actions">
        <button type="button" className="button button-primary" onClick={confirm} disabled={confirming || saving}>
          {confirming ? "Starting…" : "Confirm and start"}
        </button>
        {(unclear > 0 || aiJudged > 0) && (
          <p className="hint">
            <Icon name="info" /> Unclear and model-judged criteria will be reported as Inconclusive.
          </p>
        )}
      </div>
    </section>
  );
}
