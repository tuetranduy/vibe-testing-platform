import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { qualifiedPassLabel, type CancelReason, type RunVerdict, type TestReport, type TestRunSummary } from "@platform/contracts";
import { useId, type ReactNode } from "react";
import { Icon, type IconName } from "./Icon";
import { CANCEL_REASON_TEXT, ERROR_CATEGORY_LABEL, formatTime } from "./format";
import { llmChoiceText } from "./llm-format";
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

const heroLayout = "relative isolate grid grid-cols-1 items-center gap-x-12 gap-y-6 overflow-hidden rounded-3xl border border-(--tone-border) bg-(--tone-bg) p-7 min-[1080px]:grid-cols-[minmax(0,1fr)_minmax(280px,380px)]";
const heroMain = "flex min-w-0 items-start gap-6 max-[560px]:flex-col max-[560px]:gap-4";
const heroIcon = "grid size-[54px] shrink-0 place-items-center rounded-xl bg-(--tone) text-(--tone-contrast) [&>.icon]:size-9 max-[560px]:[&>.icon]:size-7";
const heroTitle = "font-heading text-[1.9rem] leading-[0.95] font-bold tracking-[-0.035em]";
const statusIconColor = {
  pass: "text-(--success)",
  fail: "text-destructive",
  blocked: "text-(--warning)",
  inconclusive: "text-(--neutral)",
};

interface Props {
  report: TestReport;
  /** Not part of the report; from the run summary or its `run.cancelled` event. */
  cancelReason: CancelReason | null;
  /** Not part of the report either: the run's model and reasoning, from its summary. */
  llm?: TestRunSummary["llm"];
}

/** The report's headline (verdict, or lifecycle + error for a partial report) with its criteria, then summary cards. */
export function ReportSummary({ report, cancelReason, llm = null }: Props) {
  const titleId = useId();
  const { summary, usage } = report;
  const decided = summary.passed + summary.failed;

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <Headline report={report} cancelReason={cancelReason} titleId={titleId} />

      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))] gap-4">
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
          {llm && <p className="stat-sub">{llmChoiceText(llm)}</p>}
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
      <section className={cn("report-hero", heroLayout, `hero-${ui.tone}`)} aria-labelledby={titleId}>
        <div className={heroMain}>
          <span className={heroIcon} aria-hidden="true">
            <Icon name={HERO_ICON[report.verdict]} />
          </span>
          <div className="flex min-w-0 flex-col gap-2">
            <p className="eyebrow">Final report</p>
            <h2 id={titleId} className={heroTitle}>
              <span className="sr-only">Verdict:</span> {qualifiedPassLabel(report) ?? ui.label}
            </h2>
            <p className="mt-1.5 max-w-[56ch] text-[0.9rem] leading-normal text-muted-foreground">
              {passed} of {plural(totalCriteria, "criterion", "criteria")} passed. {VERDICT_EXPLAIN[report.verdict]}
            </p>
            {report.summary.nonCritical.notPassed > 0 && (
              <p className="font-semibold">
                {plural(report.summary.nonCritical.notPassed, "non-critical criterion", "non-critical criteria")} did not pass; the
                verdict ignores {report.summary.nonCritical.notPassed === 1 ? "it" : "them"}.
              </p>
            )}
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
        {report.error && <p className="font-semibold">{ERROR_CATEGORY_LABEL[report.error.category]}</p>}
        <p>The run stopped because of an infrastructure problem. Infrastructure errors never count as a failed criterion.</p>
        {report.error?.message && (
          <Collapsible className="mt-2">
            <CollapsibleTrigger className="cursor-pointer text-sm text-accent-foreground hover:underline">Technical details</CollapsibleTrigger>
            <CollapsibleContent asChild>
              <pre className="mt-2 max-h-60 overflow-auto rounded-md border border-border bg-(--surface-sunken) p-3 font-mono text-xs whitespace-pre-wrap wrap-anywhere">{report.error.message}</pre>
            </CollapsibleContent>
          </Collapsible>
        )}
      </>
    );
  } else if (report.lifecycle === "CANCELLED") {
    body = <p>{cancelReason ? CANCEL_REASON_TEXT[cancelReason] : "The run was cancelled."}</p>;
  } else {
    body = <p>The run ended without a verdict.</p>;
  }
  return (
    <section className={cn("report-hero", heroLayout, "min-[1080px]:grid-cols-1", errored ? "hero-error" : "hero-stopped")} aria-labelledby={titleId}>
      <div className={heroMain}>
        <span className={heroIcon} aria-hidden="true">
          <Icon name={errored ? "error" : "stop"} />
        </span>
        <div className="flex min-w-0 flex-col gap-2">
          <p className="eyebrow">Partial report</p>
          <h2 id={titleId} className={heroTitle}>
            {errored ? "Run errored" : report.lifecycle === "CANCELLED" ? "Run cancelled" : "Run ended"}
          </h2>
          {body}
          <p className="text-muted-foreground">The run stopped before it finished. Below is everything it recorded up to that point.</p>
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
    <div role="group" aria-labelledby={id} className="hero-aside flex flex-col gap-3.5 rounded-xl border border-(--tone-border) bg-card px-[22px] py-5">
      <div className="mix-head">
        <p id={id} className="panel-title">
          Criteria
        </p>
        <p className="mix-total">{summary.totalCriteria} total</p>
      </div>
      {summary.totalCriteria === 0 ? (
        <p className="text-muted-foreground">No results recorded.</p>
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
              <li key={status} className={n === 0 ? "is-zero" : undefined}>
                <Icon className={statusIconColor[CRITERION_STATUS_UI[status].tone]} name={CRITERION_STATUS_UI[status].icon} />
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
    <Card role="group" aria-labelledby={id} className="stat">
      <p id={id} className="text-[0.8125rem] font-medium text-muted-foreground">
        {label}
      </p>
      <p className="stat-value">{value}</p>
      {children}
    </Card>
  );
}
