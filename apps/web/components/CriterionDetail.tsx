import type { AcceptanceCriterion, CriterionResult, TestReport } from "@platform/contracts";
import type { ArtifactInfo, StepInfo } from "../lib/progress-reducer";
import { ArtifactList } from "./ArtifactList";
import { FailureDiagnostics } from "./FailureDiagnostics";

export interface CriterionDetailProps {
  id: string;
  /** The id of the toggle button that labels this region. */
  labelledBy: string;
  runId: string;
  result: CriterionResult;
  criterion: AcceptanceCriterion | null;
  diagnostics: TestReport["diagnostics"];
  artifacts: ReadonlyMap<string, ArtifactInfo>;
  steps: ReadonlyMap<string, StepInfo>;
}

/** A criterion's details, in a fixed order: requirement → expected → actual → steps → evidence → diagnostics. */
export function CriterionDetail({ id, labelledBy, runId, result, criterion, diagnostics, artifacts, steps }: CriterionDetailProps) {
  const findings = diagnostics.filter((d) => d.criterionId === result.criterionId);
  return (
    <div id={id} role="region" aria-labelledby={labelledBy} className="result-detail">
      <section className="detail-section">
        <h4>Requirement</h4>
        {criterion ? (
          <>
            <blockquote className="source-quote">“{criterion.sourceText}”</blockquote>
            <p className="hint">From your requirement</p>
            {criterion.preconditions.length > 0 && (
              <ul className="needs">
                {criterion.preconditions.map((p, i) => (
                  <li key={i}>Needs: {p.description}</li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <p className="muted">The requirement text isn&apos;t available for this run.</p>
        )}
      </section>

      <section className="detail-section">
        <h4>Expected</h4>
        <p className="detail-value">{result.expected}</p>
      </section>

      <section className="detail-section">
        <h4>Actual</h4>
        {result.actual === null ? <p className="muted">Not observed</p> : <p className="detail-value">{result.actual}</p>}
      </section>

      <section className="detail-section">
        <h4>Related steps</h4>
        {result.relatedStepIds.length === 0 ? (
          <p className="muted">No steps are linked to this criterion.</p>
        ) : (
          <ol className="step-list">
            {result.relatedStepIds.map((stepId) => {
              const step = steps.get(stepId);
              return <li key={stepId}>{step ? <span>{step.message}</span> : <span className="muted">Step {stepId}</span>}</li>;
            })}
          </ol>
        )}
      </section>

      <section className="detail-section">
        <h4>Evidence</h4>
        <ArtifactList
          runId={runId}
          artifactIds={result.evidenceArtifactIds}
          artifacts={artifacts}
          emptyText="No evidence was captured for this criterion."
        />
      </section>

      <section className="detail-section">
        <h4>Diagnostics</h4>
        <FailureDiagnostics findings={findings} emptyText="No diagnostics for this criterion." />
      </section>
    </div>
  );
}
