"use client";

import { Button } from "@/components/ui/button";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { assumptionsOf, isInferred, qualifiedPassLabel, type TestReport, type TestRunSummary } from "@platform/contracts";
import { useEffect, useRef, useState } from "react";
import { getReport, getRun } from "../lib/api";
import { AssumptionItems } from "./Assumptions";
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
      <p className="text-muted-foreground" role="status">
        Preparing the report…
      </p>
    );
  }
  if (state.status === "error") {
    return (
      <p role="alert" className="flex items-start gap-1.5 text-sm font-medium text-destructive [&_.icon]:mt-px">
        {state.message}
      </p>
    );
  }

  const { report, summary } = state;
  const statementOf = new Map((report.requirement?.criteria ?? []).map((c) => [c.id, c.statement]));
  const addedIds = new Set((report.requirement?.criteria ?? []).filter(isInferred).map((c) => c.id));
  const s = report.summary;
  return (
    <article className="print-report theme-light">
      <div className="print-toolbar no-print">
        <Button type="button" onClick={() => window.print()}>
          Print or save as PDF
        </Button>
        <Button asChild variant="outline">
          <a href={`/runs/${encodeURIComponent(runId)}`}>
            Back to the run
          </a>
        </Button>
      </div>

      <header className="print-head">
        <p className="eyebrow">Test report</p>
        <h1>{runTitle(summary)}</h1>
        <dl className="print-facts">
          <div>
            <dt>Result</dt>
            <dd>
              <strong>
                {report.verdict ? (qualifiedPassLabel(report) ?? VERDICT_LABEL[report.verdict]) : report.partial ? "Partial report (no verdict)" : "No verdict"}
              </strong>
            </dd>
          </div>
          <div>
            <dt>Website</dt>
            <dd>{report.targetUrl}</dd>
          </div>
          <div>
            <dt>Run</dt>
            <dd className="font-mono">
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

      {report.requirement && assumptionsOf(report.requirement).length > 0 && (
        <section>
          <h2>Assumptions</h2>
          {report.requirement.intent && (
            <p>
              What was understood: <span>{report.requirement.intent.goal}</span>
            </p>
          )}
          <AssumptionItems requirement={report.requirement} />
        </section>
      )}

      <section>
        <h2>Summary</h2>
        <Table className="data-table print-table">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Criteria</TableHead>
              <TableHead scope="col">Passed</TableHead>
              <TableHead scope="col">Failed</TableHead>
              <TableHead scope="col">Blocked</TableHead>
              <TableHead scope="col">Inconclusive</TableHead>
              <TableHead scope="col">Confirmed by rerun</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>{s.totalCriteria}</TableCell>
              <TableCell>{s.passed}</TableCell>
              <TableCell>{s.failed}</TableCell>
              <TableCell>{s.blocked}</TableCell>
              <TableCell>{s.inconclusive}</TableCell>
              <TableCell>{s.confirmedByRerun}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
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
              {addedIds.has(c.criterionId) && " (added by the platform)"}
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
                  <dt>{c.verdictSource === "AI_JUDGMENT" ? "AI reasoning" : "AI note (never a status)"}</dt>
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
