"use client";

import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { describeExpectedOutcome, isInferred, type AcceptanceCriterion, type CriterionProposalResponse, type ExpectedOutcome, type FactRequest, type SiteCheck } from "@platform/contracts";
import { useEffect, useRef, useState } from "react";
import { CheckEditor } from "./CheckEditor";
import { CheckRewrite } from "./CheckRewrite";
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
  /**
   * Rewrites the check from the user's words (2026-11-19): the proposal, or the error to show; `onAccept` saves it.
   * Absent: no free text, and an AI-judged check cannot be edited.
   */
  onRevise?: (instruction: string) => Promise<{ proposal: CriterionProposalResponse } | { error: string }>;
  onAccept?: (proposalId: string) => Promise<string | null>;
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
  onRevise,
  onAccept,
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
    <Card as="article" className={`criterion${c.ambiguity ? " criterion-unclear" : aiJudged ? " criterion-ai" : ""}`} aria-labelledby={`${c.id}-title`}>
      <h3 id={`${c.id}-title`} className="criterion-id">
        {c.id}
      </h3>
      <div className="criterion-body">
        {(c.ambiguity || aiJudged) && (
          <div className="flex flex-wrap gap-1.5">
            {c.ambiguity && (
              <Badge variant="outline" className="min-h-6 gap-1.5 border-transparent bg-(--warning-bg) text-(--warning)">
                <Icon name="warning" /> Needs clarification
              </Badge>
            )}
            {aiJudged && (
              <Badge variant="outline" className="min-h-6 gap-1.5 border-transparent bg-(--info-bg) text-(--info)">
                <Icon name="info" /> AI-judged
              </Badge>
            )}
          </div>
        )}

        <p className="criterion-statement">{c.statement}</p>
        {isInferred(c) && c.rationale && (
          <p className="mt-[0.35rem] text-sm text-muted-foreground">
            <span className="note-title">Why it was added</span> <span>{c.rationale}</span>
          </p>
        )}
        {c.assumption && <p className="mt-[0.35rem] text-sm text-muted-foreground">Assumed: {c.assumption}</p>}

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

        {editing && onRevise && onAccept && <CheckRewrite criterionId={c.id} currentPreconditions={c.preconditions} busy={busy} onRevise={onRevise} onAccept={onAccept} />}
        {editing && aiJudged && (
          <div className="actions flex flex-wrap items-center gap-2">
            <Button variant="ghost" type="button" onClick={() => setEditing(false)}>
              Close
            </Button>
          </div>
        )}

        <p className="criterion-source">
          From your requirement: <q>{c.sourceText}</q>
        </p>

        {onCriticalChange && (
          <div className="grid gap-1 [&_.hint]:m-0">
            <label className="flex min-h-8 cursor-pointer items-center gap-2.5 text-[0.9375rem] has-disabled:cursor-not-allowed has-disabled:text-muted-foreground">
              <Checkbox
                checked={c.critical}
                disabled={busy || (c.critical && !canMakeNonCritical)}
                aria-describedby={`${c.id}-weight-hint`}
                onCheckedChange={async (checked) => setWeightError(await onCriticalChange(checked === true))}
              />
              <span>Critical</span>
            </label>
            <p id={`${c.id}-weight-hint`} className="hint text-[0.8125rem] text-(--text-subtle) [&_.icon]:mr-0.5">
              {c.critical
                ? canMakeNonCritical
                  ? "Decides the verdict. Untick for a nice-to-have that is reported but never fails the run."
                  : "Decides the verdict. At least one criterion must stay critical."
                : "Non-critical: reported with its result, but the verdict ignores it."}
            </p>
            {weightError && (
              <p role="alert" className="flex items-start gap-1.5 text-sm font-medium text-destructive [&_.icon]:mt-px">
                <Icon name="error" /> {weightError}
              </p>
            )}
          </div>
        )}

        {c.preconditions.some((p) => p.kind === "authenticated") && (
          <ul className="criterion-needs">
            {c.preconditions.filter((p) => p.kind === "authenticated").map((p, i) => (
              <li key={i}>
                Needs a signed-in user
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
            <p>{onRevise ? "To check an exact value instead, use Edit check and describe it in your own words." : "Judged by AI only — it can only be removed."}</p>
          </div>
        )}

        {!editing && removing && (
          <div role="group" aria-labelledby={`${c.id}-remove-title`} className="note note-warning">
            <p id={`${c.id}-remove-title`} className="note-title">
              Remove {c.id}?
            </p>
            <p>It won&apos;t be checked in this run.</p>
            <div className="actions flex flex-wrap items-center gap-2">
              <Button variant="destructive"
                type="button"
                onClick={() => {
                  setRemoving(false);
                  onRemove();
                }}
                disabled={busy}
              >
                Yes, remove
              </Button>
              <Button variant="outline" type="button" onClick={() => setRemoving(false)} autoFocus>
                Keep it
              </Button>
            </div>
          </div>
        )}

        {!editing && !removing && (
          <div className="actions flex flex-wrap items-center gap-2">
            {(!aiJudged || onRevise) && (
              <Button variant="outline"
                ref={editButton}
                type="button"
                onClick={() => setEditing(true)}
                disabled={busy}
                aria-label={`Edit check ${c.id}`}
              >
                Edit check
              </Button>
            )}
            <Button variant="ghost"
              type="button"
              onClick={() => setRemoving(true)}
              disabled={busy || !canRemove}
              title={canRemove ? undefined : "At least one criterion is required"}
              aria-label={`Remove ${c.id}`}
            >
              Remove
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}
