"use client";

import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { describeExpectedOutcome, type AcceptanceCriterion, type CriterionProposalResponse } from "@platform/contracts";
import { useId, useState } from "react";
import { Icon } from "./Icon";

interface Props {
  criterionId: string;
  /** What the check needs now, to mark what a proposal adds. */
  currentPreconditions: AcceptanceCriterion["preconditions"];
  /** Another save is in flight: rewriting is paused. */
  busy: boolean;
  /** Asks the AI for a proposal; resolves to it, or to the error to show. */
  onRevise: (instruction: string) => Promise<{ proposal: CriterionProposalResponse } | { error: string }>;
  /** Saves the proposal; resolves to null when saved, or the error to show. */
  onAccept: (proposalId: string) => Promise<string | null>;
}

const MIN = 3;
const MAX = 500;

/**
 * A check in the user's own words (2026-11-19, plan 2026-11-19-rewrite-check-from-text): the AI rewrites the criterion
 * from them, the proposal is shown as it would be checked, and nothing changes until "Use this check".
 */
export function CheckRewrite({ criterionId, currentPreconditions, busy, onRevise, onAccept }: Props) {
  const uid = useId();
  const [words, setWords] = useState("");
  const [working, setWorking] = useState<"rewriting" | "saving" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<CriterionProposalResponse | null>(null);
  const proposed = proposal?.criteria.find((c) => c.id === criterionId) ?? null;

  async function rewrite() {
    const instruction = words.trim();
    if (instruction.length < MIN || instruction.length > MAX) {
      setError(`Describe the check in ${MIN} to ${MAX} characters.`);
      return;
    }
    setWorking("rewriting");
    setError(null);
    setProposal(null);
    const out = await onRevise(instruction);
    setWorking(null);
    if ("error" in out) setError(out.error);
    else setProposal(out.proposal);
  }

  async function accept() {
    if (!proposal) return;
    setWorking("saving");
    setError(null);
    const err = await onAccept(proposal.proposalId);
    setWorking(null);
    if (err !== null) setError(err);
  }

  return (
    <div className="check-rewrite stack">
      <div className="field">
        <label htmlFor={`${uid}-words`}>Describe the check in your own words</label>
        <Textarea
          id={`${uid}-words`}
          rows={2}
          maxLength={MAX}
          value={words}
          placeholder="e.g. the price is shown in euros and is under €50"
          onChange={(e) => setWords(e.target.value)}
          aria-describedby={`${uid}-hint`}
        />
        <p id={`${uid}-hint`} className="hint">
          AI turns this into a check. You see it before anything changes.
        </p>
      </div>
      {error && (
        <p role="alert" className="field-error">
          <Icon name="error" /> {error}
        </p>
      )}
      <div className="actions">
        <Button variant="outline" type="button"  onClick={() => void rewrite()} disabled={busy || working !== null}>
          {working === "rewriting" ? "Rewriting…" : "Rewrite with AI"}
        </Button>
      </div>

      {proposal && proposed && (
        <div className="criterion-check" role="group" aria-labelledby={`${uid}-proposal`}>
          <p id={`${uid}-proposal`} className="criterion-check-title">
            Proposed check
          </p>
          <p className="criterion-statement">{proposed.statement}</p>
          <p>{describeExpectedOutcome(proposed.expectedOutcome, proposal.facts)}</p>
          {proposed.preconditions.length > 0 && (
            <>
              <p id={`${uid}-needs`} className="criterion-check-title">
                What it needs
              </p>
              {/* A rewrite may add a login or test data the user never asked for: shown before it is used (review finding). */}
              <ul aria-labelledby={`${uid}-needs`} className="criterion-needs">
                {proposed.preconditions.map((p, i) => (
                  <li key={`${i}-${p.description}`}>
                    {p.description}
                    {!currentPreconditions.some((q) => q.kind === p.kind && q.description === p.description) && " (new)"}
                  </li>
                ))}
              </ul>
            </>
          )}
          {proposed.ambiguity && (
            <p className="hint">
              <Icon name="warning" /> {proposed.ambiguity.reason}
            </p>
          )}
          <div className="actions">
            <Button type="button"  onClick={() => void accept()} disabled={busy || working !== null}>
              {working === "saving" ? "Saving…" : "Use this check"}
            </Button>
            <Button variant="ghost" type="button"  onClick={() => setProposal(null)} disabled={working !== null}>
              Discard
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
