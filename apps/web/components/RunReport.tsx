"use client";

import type { CancelReason, TestReport, TestRunSummary } from "@platform/contracts";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { getReport } from "../lib/api";
import type { ArtifactInfo, StepInfo } from "../lib/progress-reducer";
import { ArtifactList } from "./ArtifactList";
import { CriteriaResults } from "./CriteriaResults";
import { Disclosure } from "./Disclosure";
import { FailureDiagnostics } from "./FailureDiagnostics";
import { GeneratedTestViewer } from "./GeneratedTestViewer";
import { Icon } from "./Icon";
import { RerunPanel } from "./RerunPanel";
import { ReportSummary } from "./ReportSummary";

interface Props {
  runId: string;
  /**
   * The run's artifacts and steps, from its event stream (`artifact.created`, `step.recorded`): the
   * report carries only ids, and there is no endpoint that lists a run's artifacts.
   */
  artifacts: readonly ArtifactInfo[];
  steps: readonly StepInfo[];
  cancelReason?: CancelReason | null;
  /** The run's model and reasoning, from its summary (null: a run created before model choice). */
  llm?: TestRunSummary["llm"];
  /** Shown with the error when the report can't be loaded (the outcome from the run summary / events). */
  fallback?: ReactNode;
  /** The run's secret names (from its summary): a rerun asks for them again. Absent: no rerun offered. */
  secretNames?: readonly string[];
}

type State = { status: "loading" } | { status: "ready"; report: TestReport } | { status: "error"; message: string };

/**
 * The final report of a terminal run: full for COMPLETED, partial (`partial: true`) for ERRORED /
 * CANCELLED. Criterion-centric: summary → criteria (expandable) → diagnostics → generated test → all evidence.
 */
export function RunReport({ runId, artifacts, steps, cancelReason = null, llm = null, fallback, secretNames }: Props) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const artifactMap = useMemo(() => new Map(artifacts.map((a) => [a.artifactId, a])), [artifacts]);
  const stepMap = useMemo(() => new Map(steps.map((s) => [s.stepId, s])), [steps]);

  useEffect(() => {
    let live = true;
    setState({ status: "loading" });
    getReport(runId).then(
      (report) => live && setState({ status: "ready", report }),
      (err: unknown) => live && setState({ status: "error", message: err instanceof Error ? err.message : "Something went wrong." }),
    );
    return () => {
      live = false;
    };
  }, [runId, attempt]);

  if (state.status === "loading") {
    return (
      <p className="muted" role="status">
        Loading report…
      </p>
    );
  }
  if (state.status === "error") {
    return (
      <>
        <div role="alert" className="banner banner-error">
          <Icon name="warning" />
          <div>
            <p className="banner-title">The report couldn&apos;t be loaded</p>
            <p>{state.message}</p>
            <div className="actions">
              <button type="button" className="button button-secondary" onClick={() => setAttempt((n) => n + 1)}>
                Try again
              </button>
            </div>
          </div>
        </div>
        {fallback}
      </>
    );
  }

  const { report } = state;
  const general = report.diagnostics.filter((d) => d.criterionId === null);
  return (
    <>
      <ReportSummary report={report} cancelReason={cancelReason} llm={llm} />
      <CriteriaResults
        runId={runId}
        criteria={report.criteria}
        requirement={report.requirement}
        diagnostics={report.diagnostics}
        artifacts={artifactMap}
        steps={stepMap}
        partial={report.partial}
      />
      {general.length > 0 && (
        <section className="card" aria-labelledby="diagnostics-title">
          <h2 id="diagnostics-title" className="card-title">
            Diagnostics
          </h2>
          <FailureDiagnostics findings={general} />
        </section>
      )}
      {report.generatedTest && <GeneratedTestViewer test={report.generatedTest} playwright={report.playwright} requirement={report.requirement} />}
      {secretNames && report.generatedTest && report.generatedTest.compiledCriteria.length > 0 && (
        <RerunPanel runId={runId} secretNames={secretNames} compiledCount={report.generatedTest.compiledCriteria.length} />
      )}
      <Disclosure title={`All evidence (${artifacts.length})`} hint="Every screenshot, trace and video the run stored.">
        <ArtifactList runId={runId} artifactIds={artifacts.map((a) => a.artifactId)} artifacts={artifactMap} />
      </Disclosure>
    </>
  );
}
