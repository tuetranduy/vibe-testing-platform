"use client";

import type { AcceptanceCriterion, CriterionResult, NormalizedRequirement, TestReport } from "@platform/contracts";
import { useState } from "react";
import type { ArtifactInfo, StepInfo } from "../lib/progress-reducer";
import { CriterionDetail } from "./CriterionDetail";
import { Icon } from "./Icon";
import { CRITERION_STATUS_UI, VERDICT_SOURCE_TEXT, disagreementText, reasonText, unconfirmedWhy } from "./report-format";
import { CriterionStatusBadge } from "./StatusBadge";

interface Props {
  runId: string;
  criteria: readonly CriterionResult[];
  requirement: NormalizedRequirement | null;
  diagnostics: TestReport["diagnostics"];
  artifacts: ReadonlyMap<string, ArtifactInfo>;
  steps: ReadonlyMap<string, StepInfo>;
  /** A partial report: say the run stopped when there are no results. */
  partial?: boolean;
}

/** The criterion-centric results: one row per criterion, each expandable into its evidence. */
export function CriteriaResults({ runId, criteria, requirement, diagnostics, artifacts, steps, partial = false }: Props) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const byId = new Map((requirement?.criteria ?? []).map((c) => [c.id, c]));
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <section className="card" aria-labelledby="criteria-title">
      <div className="card-head">
        <h2 id="criteria-title">Criteria</h2>
        {criteria.length > 0 && <p className="muted">Open a criterion for its expected and actual values, steps and evidence.</p>}
      </div>
      {criteria.length === 0 ? (
        <p className="muted">No criterion results were recorded{partial ? " before the run stopped" : ""}.</p>
      ) : (
        <ul className="results">
          {criteria.map((r) => (
            <CriterionRow
              key={r.criterionId}
              runId={runId}
              result={r}
              criterion={byId.get(r.criterionId) ?? null}
              expanded={open.has(r.criterionId)}
              onToggle={() => toggle(r.criterionId)}
              diagnostics={diagnostics}
              artifacts={artifacts}
              steps={steps}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

interface RowProps {
  runId: string;
  result: CriterionResult;
  criterion: AcceptanceCriterion | null;
  expanded: boolean;
  onToggle(): void;
  diagnostics: TestReport["diagnostics"];
  artifacts: ReadonlyMap<string, ArtifactInfo>;
  steps: ReadonlyMap<string, StepInfo>;
}

function CriterionRow({ runId, result: r, criterion, expanded, onToggle, diagnostics, artifacts, steps }: RowProps) {
  const toggleId = `criterion-${r.criterionId}-toggle`;
  const detailId = `criterion-${r.criterionId}-detail`;
  const decided = r.status === "PASS" || r.status === "FAIL";

  return (
    <li className={`result result-${CRITERION_STATUS_UI[r.status].tone}`}>
      <h3 className="result-heading">
        <button
          type="button"
          id={toggleId}
          className="result-toggle"
          aria-expanded={expanded}
          aria-controls={expanded ? detailId : undefined}
          onClick={onToggle}
        >
          <span className="result-id">{r.criterionId}</span>{" "}
          <span className="result-statement">{criterion?.statement ?? `Criterion ${r.criterionId}`}</span>
          <Icon name="chevron" className="result-chevron" />
        </button>
      </h3>

      <div className="result-meta">
        <CriterionStatusBadge status={r.status} />
        {decided && r.verdictSource ? (
          <>
            <span className={`confirmation confirmation-${r.verdictSource === "PLAYWRIGHT_RERUN" ? "yes" : "no"}`}>
              {VERDICT_SOURCE_TEXT[r.verdictSource]}
            </span>
            {r.verdictSource === "EXPLORATION_ONLY" && <span className="result-sub">{unconfirmedWhy(r.rerunOutcome)}</span>}
          </>
        ) : (
          <span className="result-reason">{reasonText(r.reason)}</span>
        )}
        {r.reason === "DISCOVERY_RERUN_DISAGREE" && <span className="result-sub">{disagreementText(r.provisional.status, r.rerunOutcome)}</span>}
      </div>

      {r.aiNote && (
        <div role="note" aria-label="AI note" className="ai-note">
          <p className="ai-note-title">
            <Icon name="note" /> AI note
          </p>
          <p>{r.aiNote}</p>
          <p className="hint">The AI model&apos;s opinion. It never sets the status.</p>
        </div>
      )}

      {expanded && (
        <CriterionDetail
          id={detailId}
          labelledBy={toggleId}
          runId={runId}
          result={r}
          criterion={criterion}
          diagnostics={diagnostics}
          artifacts={artifacts}
          steps={steps}
        />
      )}
    </li>
  );
}
