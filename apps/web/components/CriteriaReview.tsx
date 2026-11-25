"use client";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ADDED_BY_PLATFORM, describeExpectedOutcome, isInferred, type NormalizedRequirement, type SiteAnalysis } from "@platform/contracts";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ApiRequestError, acceptProposal, cancelRun, confirmCriteria, getCriteria, getSiteAnalysis, reviseCriterion, updateCriteria, type ConfirmResult } from "../lib/api";
import { CriterionCard } from "./CriterionCard";
import { Icon } from "./Icon";
import { LiveSiteSummary } from "./SiteAnalysisPanel";

interface Props {
  runId: string;
  actionTarget?: string;
  /** Called once the server has frozen the criteria and queued the run. */
  onConfirmed: (result: ConfirmResult) => void;
}

/** "AC-2" / "AC-1 and AC-2" / "AC-1, AC-2 and AC-3" */
const listIds = (ids: string[]) => (ids.length <= 1 ? ids.join("") : `${ids.slice(0, -1).join(", ")} and ${ids.at(-1)}`);

const messageOf = (err: unknown) => (err instanceof ApiRequestError ? err.message : "Something went wrong. Please try again.");

export function CriteriaReview({ runId, actionTarget, onConfirmed }: Props) {
  const router = useRouter();
  const [requirement, setRequirement] = useState<NormalizedRequirement | null>(null);
  const [startingOver, setStartingOver] = useState<"ask" | "working" | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [allowTargetActions, setAllowTargetActions] = useState(false);
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
  useEffect(() => {
    let live = true;
    getSiteAnalysis(runId).then(
      (a) => {
        if (!live) return;
        setAnalysis(a);
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

  /** Saves a check the AI rewrote from the user's words (2026-11-19); null, or the error to show. */
  async function acceptRewrite(proposalId: string): Promise<string | null> {
    setSaving(true);
    setError(null);
    try {
      setRequirement(await acceptProposal(runId, proposalId));
      return null;
    } catch (err) {
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
      onConfirmed(await (actionTarget && allowTargetActions ? confirmCriteria(runId, {}, true) : confirmCriteria(runId)));
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
      <p className="text-muted-foreground" role="status">
        Loading criteria…
      </p>
    );
  }

  const { criteria } = requirement;
  const unclear = criteria.filter((c) => c.ambiguity !== null).length;
  const aiJudged = criteria.filter((c) => c.expectedOutcome.kind === "semantic").length;
  const nonCritical = criteria.filter((c) => !c.critical).length;
  const openEdits = criteria.map((c) => c.id).filter((id) => editing.has(id));
  // What the analysis added on its own is reviewed apart from the user's own checks (2026-11-11).
  const stated = criteria.filter((c) => !isInferred(c));
  const added = criteria.filter(isInferred);
  const notes = requirement.intent?.notes ?? [];
  const card = (c: (typeof criteria)[number]) => (
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
      onRevise={(instruction) =>
        reviseCriterion(runId, c.id, instruction).then(
          (proposal) => ({ proposal }),
          (err: unknown) => ({ error: messageOf(err) }),
        )
      }
      onAccept={acceptRewrite}
    />
  );

  return (
    <section className="review" aria-labelledby="review-title">
      <div className="review-main">
        <div className="review-head">
          <h2 id="review-title" className="font-heading text-2xl leading-[1.2] font-semibold tracking-[-0.015em]">
            Review your test
          </h2>
          <p className="text-muted-foreground">
            Check that these match your instructions. You can edit a check or remove anything you don’t need.
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

        {requirement.intent && (
          <p className="m-0 flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="note-title">What I understood</span> <span>{requirement.intent.goal}</span>
          </p>
        )}

        <div className="criteria-list">{stated.map(card)}</div>

        {(added.length > 0 || notes.length > 0) && (
          <div className="mt-5 grid gap-3 border-t border-border pt-5 [&>.text-muted-foreground]:m-0" role="group" aria-labelledby="added-title">
            <h3 id="added-title" className="m-0 text-base">
              {ADDED_BY_PLATFORM}
            </h3>
            <p className="text-muted-foreground">
              Your instructions were short, so these checks were added from what the site shows. Remove any that you did not mean.
            </p>
            <div className="criteria-list">{added.map(card)}</div>
            {notes.length > 0 && (
              <ul className="m-0 grid gap-[0.4rem] pl-[1.1rem] text-[0.9rem]">
                {notes.map((n, i) => (
                  <li key={`${i}-${n}`}>{n}</li>
                ))}
              </ul>
            )}
          </div>
        )}

      </div>

      <aside className="review-side" aria-labelledby="confirm-title">
        <Card className="confirm-panel">
          <p className="confirm-status">Waiting for you</p>
          <h3 id="confirm-title" className="confirm-title">
            Do these checks match what you meant?
          </h3>
          <p className="text-muted-foreground">Nothing runs until you confirm.</p>
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
            {nonCritical > 0 && (
              <div>
                <dt>Non-critical</dt>
                <dd>{nonCritical}</dd>
              </div>
            )}
          </dl>
          {actionTarget && (
            <div className="flex items-start gap-2">
              <Checkbox id="approve-target-actions" checked={allowTargetActions} disabled={confirming}
                onCheckedChange={(checked) => setAllowTargetActions(checked === true)} aria-describedby="approve-target-actions-hint" />
              <div>
                <label htmlFor="approve-target-actions">Allow this test to make changes on {actionTarget}</label>
                <p id="approve-target-actions-hint" className="text-sm text-muted-foreground">
                  This allows actions in the test such as placing an order or submitting a payment. An enabled replay can repeat those actions.
                </p>
              </div>
            </div>
          )}
          <Button size="lg" className="h-auto min-h-8 w-full whitespace-normal"
            type="button"
            onClick={confirm}
            disabled={confirming || saving || openEdits.length > 0}
            aria-describedby={openEdits.length > 0 ? "confirm-blocked" : undefined}
          >
            {confirming ? "Starting…" : "Confirm and start"}
            <Icon name="arrow" />
          </Button>
          {openEdits.length > 0 && (
            <p id="confirm-blocked" className="hint text-[0.8125rem] text-(--text-subtle) [&_.icon]:mr-0.5">
              <Icon name="info" /> Save or discard your {openEdits.length === 1 ? "edit" : "edits"} to {listIds(openEdits)} first.
            </p>
          )}
          {(unclear > 0 || aiJudged > 0) && (
            <p className="hint text-[0.8125rem] text-(--text-subtle) [&_.icon]:mr-0.5">
              <Icon name="info" /> Model-judged criteria are judged by AI from what the page shows; unclear checks may be reported as
              Inconclusive.
            </p>
          )}
          {startingOver === null ? (
            <Button variant="outline" className="h-auto min-h-8 w-full whitespace-normal"
              type="button"
              onClick={() => setStartingOver("ask")}
              disabled={confirming || saving}
            >
              <Icon name="restart" />
              Start over with a revised requirement
            </Button>
          ) : (
            <div role="group" aria-labelledby="start-over-title" className="note note-warning">
              <p id="start-over-title" className="note-title">
                Start over?
              </p>
              <p>This cancels the current run. You can edit the requirement and start a new one.</p>
              <div className="actions flex flex-wrap items-center gap-2">
                <Button variant="destructive" type="button" onClick={startOver} disabled={startingOver === "working"}>
                  {startingOver === "working" ? "Cancelling…" : "Yes, start over"}
                </Button>
                <Button variant="outline"
                  type="button"
                  onClick={() => setStartingOver(null)}
                  disabled={startingOver === "working"}
                  autoFocus
                >
                  Keep reviewing
                </Button>
              </div>
            </div>
          )}
        </Card>
      </aside>
    </section>
  );
}
