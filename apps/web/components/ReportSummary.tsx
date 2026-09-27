import type { CancelReason, RunVerdict, TestReport } from "@platform/contracts";
import { useId, type ReactNode } from "react";
import { Icon, type IconName } from "./Icon";
import { CANCEL_REASON_TEXT, ERROR_CATEGORY_LABEL, formatTime } from "./format";
import { CRITERION_STATUS_UI, VERDICT_UI, formatCount, formatDuration, formatUsd, plural } from "./report-format";

const VERDICT_EXPLAIN: Record<RunVerdict, string> = {
  PASSED: "Every criterion passed.",
  FAILED: "At least one criterion failed.",
  BLOCKED: "No criterion failed, but at least one could not be checked.",
  INCONCLUSIVE: "No criterion failed or was blocked, but at least one could not be decided.",
};

/** The hero's large mark: a plain check / cross on the verdict's color, the status icons otherwise. */
const HERO_ICON: Record<RunVerdict, IconName> = {
  PASSED: "check",
  FAILED: "x",
  BLOCKED: "blocked",
  INCONCLUSIVE: "unknown",
};

const RERUN_TEXT = { PASSED: "passed", FAILED: "failed", ERRORED: "errored" } as const;

interface Props {
  report: TestReport;
  /** Not part of the report; from the run summary or its `run.cancelled` event. */
  cancelReason: CancelReason | null;
}

/** The report's headline (verdict, or lifecycle + error for a partial report) with its criteria, then summary cards. */
export function ReportSummary({ report, cancelReason }: Props) {
  const titleId = useId();
  const { summary, usage } = report;
  const decided = summary.passed + summary.failed;

  return (
    <div className="stack">
      <Headline report={report} cancelReason={cancelReason} titleId={titleId} />

      <div className="stats">
        <Stat label="Confirmed by rerun" value={decided === 0 ? "—" : `${summary.confirmedByRerun} of ${decided}`}>
          <p className="stat-sub">
            {decided === 0 ? "No pass or fail results to confirm." : "Pass / fail results the generated test's rerun confirmed."}
          </p>
          <p className="stat-sub">
            {report.playwright
              ? `Rerun ${RERUN_TEXT[report.playwright.status]} · ${formatDuration(report.playwright.durationMs)}`
              : "No rerun"}
          </p>
        </Stat>
        <Stat label="Duration" value={formatDuration(report.durationMs)}>
          {report.startedAt && (
            <p className="stat-sub">
              Started <time dateTime={report.startedAt}>{formatTime(report.startedAt)}</time>
            </p>
          )}
        </Stat>
        <Stat label="Estimated model cost" value={formatUsd(usage.estimatedCostUsd)}>
          <p className="stat-sub">
            {plural(usage.llmCalls, "model call")} · {formatCount(usage.inputTokens + usage.outputTokens)} tokens
          </p>
        </Stat>
      </div>
    </div>
  );
}

function Headline({ report, cancelReason, titleId }: Props & { titleId: string }) {
  if (!report.partial && report.verdict) {
    const ui = VERDICT_UI[report.verdict];
    const { passed, totalCriteria } = report.summary;
    return (
      <section className={`report-hero hero-${ui.tone}`} aria-labelledby={titleId}>
        <div className="hero-main">
          <span className="hero-icon" aria-hidden="true">
            <Icon name={HERO_ICON[report.verdict]} />
          </span>
          <div className="hero-text">
            <p className="eyebrow">Final report</p>
            <h2 id={titleId} className="hero-title">
              <span className="visually-hidden">Verdict:</span> {ui.label}
            </h2>
            <p className="hero-lede">
              {passed} of {plural(totalCriteria, "criterion", "criteria")} passed. {VERDICT_EXPLAIN[report.verdict]}
            </p>
          </div>
        </div>
        <CriteriaMix summary={report.summary} />
      </section>
    );
  }

  const errored = report.lifecycle === "ERRORED";
  let body: ReactNode;
  if (errored) {
    body = (
      <>
        {report.error && <p className="hero-detail">{ERROR_CATEGORY_LABEL[report.error.category]}</p>}
        <p>The run stopped because of an infrastructure problem. Infrastructure errors never count as a failed criterion.</p>
        {report.error?.message && (
          <details className="tech-details">
            <summary>Technical details</summary>
            <pre>{report.error.message}</pre>
          </details>
        )}
      </>
    );
  } else if (report.lifecycle === "CANCELLED") {
    body = <p>{cancelReason ? CANCEL_REASON_TEXT[cancelReason] : "The run was cancelled."}</p>;
  } else {
    body = <p>The run ended without a verdict.</p>;
  }
  return (
    <section className={`report-hero hero-partial ${errored ? "hero-error" : "hero-stopped"}`} aria-labelledby={titleId}>
      <div className="hero-main">
        <span className="hero-icon" aria-hidden="true">
          <Icon name={errored ? "error" : "stop"} />
        </span>
        <div className="hero-text">
          <p className="eyebrow">Partial report</p>
          <h2 id={titleId} className="hero-title">
            {errored ? "Run errored" : report.lifecycle === "CANCELLED" ? "Run cancelled" : "Run ended"}
          </h2>
          {body}
          <p className="muted">The run stopped before it finished. Below is everything it recorded up to that point.</p>
        </div>
      </div>
      <CriteriaMix summary={report.summary} />
    </section>
  );
}

/** Every criterion's status: the total, a bar, and the count per status in words. */
function CriteriaMix({ summary }: { summary: TestReport["summary"] }) {
  const id = useId();
  const parts = [
    ["PASS", summary.passed, "passed"],
    ["FAIL", summary.failed, "failed"],
    ["BLOCKED", summary.blocked, "blocked"],
    ["INCONCLUSIVE", summary.inconclusive, "inconclusive"],
  ] as const;
  return (
    <div role="group" aria-labelledby={id} className="hero-aside">
      <div className="mix-head">
        <p id={id} className="panel-title">
          Criteria
        </p>
        <p className="mix-total">{summary.totalCriteria} total</p>
      </div>
      {summary.totalCriteria === 0 ? (
        <p className="muted">No results recorded.</p>
      ) : (
        <>
          {/* The counts below say the same in words. */}
          <div className="mix-bar" aria-hidden="true">
            {parts.map(
              ([status, n]) =>
                n > 0 && <span key={status} className={`mix-seg mix-seg-${CRITERION_STATUS_UI[status].tone}`} style={{ flexGrow: n }} />,
            )}
          </div>
          <ul className="stat-breakdown">
            {parts.map(([status, n, word]) => (
              <li key={status} className={`tone-text-${CRITERION_STATUS_UI[status].tone}${n === 0 ? " is-zero" : ""}`}>
                <Icon name={CRITERION_STATUS_UI[status].icon} />
                {n} {word}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, children }: { label: string; value: string; children?: ReactNode }) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id} className="card stat">
      <p id={id} className="stat-label">
        {label}
      </p>
      <p className="stat-value">{value}</p>
      {children}
    </div>
  );
}
