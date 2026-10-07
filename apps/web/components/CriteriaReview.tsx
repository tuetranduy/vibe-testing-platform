"use client";

import { describeExpectedOutcome, type NormalizedRequirement, type SiteAnalysis } from "@platform/contracts";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ApiRequestError, cancelRun, confirmCriteria, getCriteria, getSiteAnalysis, updateCriteria, type ConfirmResult } from "../lib/api";
import { CriterionCard } from "./CriterionCard";
import { Icon } from "./Icon";
import { LiveSiteSummary, SuggestedTestData, chosenTestData, initialChoices, type DataChoice } from "./SiteAnalysisPanel";

interface Props {
  runId: string;
  /** Called once the server has frozen the criteria and queued the run. */
  onConfirmed: (result: ConfirmResult) => void;
}

/** "AC-2" / "AC-1 and AC-2" / "AC-1, AC-2 and AC-3" */
const listIds = (ids: string[]) => (ids.length <= 1 ? ids.join("") : `${ids.slice(0, -1).join(", ")} and ${ids.at(-1)}`);

const messageOf = (err: unknown) => (err instanceof ApiRequestError ? err.message : "Something went wrong. Please try again.");

export function CriteriaReview({ runId, onConfirmed }: Props) {
  const router = useRouter();
  const [requirement, setRequirement] = useState<NormalizedRequirement | null>(null);
  const [startingOver, setStartingOver] = useState<"ask" | "working" | null>(null);
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

  /** The live-site analysis (V1.3); null while loading, or when the run has none (it is advisory: errors hide it). */
  const [analysis, setAnalysis] = useState<SiteAnalysis | null>(null);
  const [dataChoices, setDataChoices] = useState<Record<string, DataChoice>>({});
  useEffect(() => {
    let live = true;
    getSiteAnalysis(runId).then(
      (a) => {
        if (!live) return;
        setAnalysis(a);
        setDataChoices(initialChoices(a));
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [runId]);

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

  /** Cancels this run and opens the new-test form pre-filled from it (spec 2026-09-26-criteria-check-edit). */
  async function startOver() {
    setStartingOver("working");
    setError(null);
    try {
      await cancelRun(runId);
    } catch (err) {
      // 409: the run already ended or its confirmation expired — nothing left to cancel.
      if (!(err instanceof ApiRequestError && err.status === 409)) {
        setError(messageOf(err));
        setStartingOver(null);
        return;
      }
    }
    router.push(`/runs/new?from=${encodeURIComponent(runId)}`);
  }

  async function confirm() {
    setConfirming(true);
    setError(null);
    try {
      onConfirmed(await confirmCriteria(runId, analysis ? chosenTestData(analysis, dataChoices) : {}));
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
  const nonCritical = criteria.filter((c) => !c.critical).length;
  const openEdits = criteria.map((c) => c.id).filter((id) => editing.has(id));
  const suggestedTaken = analysis ? Object.keys(chosenTestData(analysis, dataChoices)).length : 0;

  return (
    <section className="review" aria-labelledby="review-title">
      <div className="review-main">
        <div className="review-head">
          <h2 id="review-title" className="section-title">
            Review the acceptance criteria
          </h2>
          <p className="muted">
            These are what the run will check. Adjust a check&apos;s values or remove a criterion — they&apos;re frozen once you confirm. Revision{" "}
            {requirement.revision}.
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

        {analysis && <LiveSiteSummary analysis={analysis} />}

        <div className="criteria-list">
          {criteria.map((c) => (
            <CriterionCard
              key={c.id}
              siteCheck={analysis?.checks.find((check) => check.criterionId === c.id)}
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
              onCriticalChange={(critical) => save(criteria.map((x) => (x.id === c.id ? { ...x, critical } : x)))}
              canMakeNonCritical={criteria.filter((x) => x.critical).length > 1}
              onEditingChange={(open) => editingChange(c.id, open)}
            />
          ))}
        </div>

        {analysis && (
          <SuggestedTestData
            analysis={analysis}
            choices={dataChoices}
            disabled={confirming}
            onChange={(key, choice) => setDataChoices((prev) => ({ ...prev, [key]: choice }))}
          />
        )}
      </div>

      <aside className="review-side" aria-labelledby="confirm-title">
        <div className="card confirm-panel">
          <p className="confirm-status">Waiting for you</p>
          <h3 id="confirm-title" className="confirm-title">
            Do these checks match what you meant?
          </h3>
          <p className="muted">Nothing runs until you confirm.</p>
          <dl className="confirm-counts">
            <div>
              <dt>Criteria</dt>
              <dd>{criteria.length}</dd>
            </div>
            {unclear > 0 && (
              <div className="count-warning">
                <dt>Unclear</dt>
                <dd>{unclear}</dd>
              </div>
            )}
            {aiJudged > 0 && (
              <div className="count-info">
                <dt>Judged by a model only</dt>
                <dd>{aiJudged}</dd>
              </div>
            )}
            {suggestedTaken > 0 && (
              <div className="count-info">
                <dt>Suggested test data taken</dt>
                <dd>{suggestedTaken}</dd>
              </div>
            )}
            {nonCritical > 0 && (
              <div>
                <dt>Non-critical</dt>
                <dd>{nonCritical}</dd>
              </div>
            )}
          </dl>
          <button
            type="button"
            className="button button-primary button-lg button-block"
            onClick={confirm}
            disabled={confirming || saving || openEdits.length > 0}
            aria-describedby={openEdits.length > 0 ? "confirm-blocked" : undefined}
          >
            {confirming ? "Starting…" : "Confirm and start"}
            <Icon name="arrow" />
          </button>
          {openEdits.length > 0 && (
            <p id="confirm-blocked" className="hint">
              <Icon name="info" /> Save or discard your {openEdits.length === 1 ? "edit" : "edits"} to {listIds(openEdits)} first.
            </p>
          )}
          {(unclear > 0 || aiJudged > 0) && (
            <p className="hint">
              <Icon name="info" /> Model-judged criteria are judged by AI from what the page shows; unclear checks may be reported as
              Inconclusive.
            </p>
          )}
          {startingOver === null ? (
            <button
              type="button"
              className="button button-secondary button-block"
              onClick={() => setStartingOver("ask")}
              disabled={confirming || saving}
            >
              <Icon name="restart" />
              Start over with a revised requirement
            </button>
          ) : (
            <div role="group" aria-labelledby="start-over-title" className="note note-warning">
              <p id="start-over-title" className="note-title">
                Start over?
              </p>
              <p>This cancels the current run. You can edit the requirement and start a new one. Test data and secrets must be entered again.</p>
              <div className="actions">
                <button type="button" className="button button-danger" onClick={startOver} disabled={startingOver === "working"}>
                  {startingOver === "working" ? "Cancelling…" : "Yes, start over"}
                </button>
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => setStartingOver(null)}
                  disabled={startingOver === "working"}
                  autoFocus
                >
                  Keep reviewing
                </button>
              </div>
            </div>
          )}
        </div>
      </aside>
    </section>
  );
}
