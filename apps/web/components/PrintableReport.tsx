"use client";

import type { TestReport, TestRunSummary } from "@platform/contracts";
import { useEffect, useRef, useState } from "react";
import { getReport, getRun } from "../lib/api";
import { ERROR_CATEGORY_LABEL, VERDICT_LABEL } from "./format";
import { CRITERION_STATUS_UI, VERDICT_SOURCE_TEXT, formatDuration, formatWhen, reasonText, runTitle } from "./report-format";

type State =
  { status: "loading" } | { status: "ready"; report: TestReport; summary: TestRunSummary } | { status: "error"; message: string };

/**
 * The report laid out for paper (V1.1 F6): every criterion expanded, no controls, the print stylesheet
 * hides the app's header. Opens the browser's print dialog once loaded, where "Save as PDF" makes the PDF —
 * the browser renders every script a requirement can be written in, which a server PDF engine would not.
 */
export function PrintableReport({ runId, autoPrint = true }: { runId: string; autoPrint?: boolean }) {
  const [state, setState] = useState<State>({ status: "loading" });
  const printed = useRef(false);

  useEffect(() => {
    let live = true;
    Promise.all([getReport(runId), getRun(runId)]).then(
      ([report, summary]) => live && setState({ status: "ready", report, summary }),
      (err: unknown) =>
        live && setState({ status: "error", message: err instanceof Error ? err.message : "The report couldn't be loaded." }),
    );
    return () => {
      live = false;
    };
  }, [runId]);

  useEffect(() => {
    if (state.status !== "ready" || !autoPrint || printed.current) return;
    printed.current = true;
    // After the layout has painted.
    const id = window.setTimeout(() => window.print(), 300);
    return () => window.clearTimeout(id);
  }, [state.status, autoPrint]);

  if (state.status === "loading") {
    return (
      <p className="muted" role="status">
        Preparing the report…
      </p>
    );
  }
  if (state.status === "error") {
    return (
      <p role="alert" className="field-error">
        {state.message}
      </p>
    );
  }

  const { report, summary } = state;
  const statementOf = new Map((report.requirement?.criteria ?? []).map((c) => [c.id, c.statement]));
  const s = report.summary;
  return (
    <article className="print-report">
      <div className="print-toolbar no-print">
        <button type="button" className="button button-primary" onClick={() => window.print()}>
          Print or save as PDF
        </button>
        <a className="button button-secondary" href={`/runs/${encodeURIComponent(runId)}`}>
          Back to the run
        </a>
      </div>

      <header className="print-head">
        <p className="eyebrow">Test report</p>
        <h1>{runTitle(summary)}</h1>
        <dl className="print-facts">
          <div>
            <dt>Result</dt>
            <dd>
              <strong>
                {report.verdict ? VERDICT_LABEL[report.verdict] : report.partial ? "Partial report (no verdict)" : "No verdict"}
              </strong>
            </dd>
          </div>
          <div>
            <dt>Website</dt>
            <dd>{report.targetUrl}</dd>
          </div>
          <div>
            <dt>Run</dt>
            <dd className="mono">
              {report.runId}
              {report.rerunOf ? ` (rerun of ${report.rerunOf})` : ""}
            </dd>
          </div>
          <div>
            <dt>When</dt>
            <dd>
              {report.startedAt ? formatWhen(report.startedAt) : "—"} · {formatDuration(report.durationMs)}
            </dd>
          </div>
          {summary.owner && (
            <div>
              <dt>By</dt>
              <dd>{summary.owner.name}</dd>
            </div>
          )}
        </dl>
        {report.error && (
          <p>
            Stopped: {ERROR_CATEGORY_LABEL[report.error.category]} — {report.error.message}
          </p>
        )}
      </header>

      {report.requirement && (
        <section>
          <h2>Requirement</h2>
          <blockquote className="print-quote">{report.requirement.originalText}</blockquote>
        </section>
      )}

      <section>
        <h2>Summary</h2>
        <table className="data-table print-table">
          <thead>
            <tr>
              <th scope="col">Criteria</th>
              <th scope="col">Passed</th>
              <th scope="col">Failed</th>
              <th scope="col">Blocked</th>
              <th scope="col">Inconclusive</th>
              <th scope="col">Confirmed by rerun</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{s.totalCriteria}</td>
              <td>{s.passed}</td>
              <td>{s.failed}</td>
              <td>{s.blocked}</td>
              <td>{s.inconclusive}</td>
              <td>{s.confirmedByRerun}</td>
            </tr>
          </tbody>
        </table>
        {s.nonCritical.total > 0 && (
          <p>
            {s.nonCritical.total} non-critical ({s.nonCritical.notPassed} did not pass): reported, but the verdict ignores them.
          </p>
        )}
      </section>

      <section>
        <h2>Criteria</h2>
        {report.criteria.length === 0 && <p>No criterion results were recorded.</p>}
        {report.criteria.map((c) => (
          <div key={c.criterionId} className="print-criterion">
            <h3>
              {c.criterionId} — {CRITERION_STATUS_UI[c.status].label}
              {!c.critical && " (non-critical)"}
            </h3>
            <p>{statementOf.get(c.criterionId) ?? `Criterion ${c.criterionId}`}</p>
            <dl className="print-facts">
              <div>
                <dt>How it was decided</dt>
                <dd>{c.verdictSource ? VERDICT_SOURCE_TEXT[c.verdictSource] : reasonText(c.reason)}</dd>
              </div>
              <div>
                <dt>Expected</dt>
                <dd>{c.expected}</dd>
              </div>
              <div>
                <dt>Actual</dt>
                <dd>{c.actual ?? "—"}</dd>
              </div>
              {c.aiNote && (
                <div>
                  <dt>AI note (never a status)</dt>
                  <dd>{c.aiNote}</dd>
                </div>
              )}
            </dl>
          </div>
        ))}
      </section>

      {report.diagnostics.length > 0 && (
        <section>
          <h2>Diagnostics</h2>
          <ul>
            {report.diagnostics.map((d, i) => (
              <li key={i}>
                {d.criterionId && <strong>{d.criterionId}: </strong>}
                {d.summary}
              </li>
            ))}
          </ul>
        </section>
      )}

      {report.generatedTest && (
        <section className="print-code">
          <h2>Generated Playwright test</h2>
          {report.playwright && (
            <p>
              Rerun {report.playwright.status.toLowerCase()} in {formatDuration(report.playwright.durationMs)}.
            </p>
          )}
          <pre>{report.generatedTest.source}</pre>
        </section>
      )}

      <section>
        <h2>Model usage</h2>
        <p>
          {report.usage.llmCalls} model calls · {report.usage.inputTokens} input and {report.usage.outputTokens} output tokens · estimated
          cost ${report.usage.estimatedCostUsd.toFixed(4)}
        </p>
      </section>
    </article>
  );
}
