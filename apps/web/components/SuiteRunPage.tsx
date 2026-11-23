"use client";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import type { SuiteRunView } from "@platform/contracts";
import { useEffect, useState } from "react";
import { cancelSuiteRun, getSuiteRun } from "../lib/api";
import { Icon } from "./Icon";
import { displayUrl, formatWhen, plural } from "./report-format";
import { LifecycleBadge, VerdictBadge } from "./StatusBadge";
import { SuiteRunOutcome, TRIGGER_LABEL, messageOf } from "./Suites";

type State = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; run: SuiteRunView };

/** While a suite run is going, how often its page asks again. */
export const SUITE_RUN_POLL_MS = 3000;

function countsText(run: SuiteRunView): string {
  const c = run.counts;
  const parts = [
    c.passed > 0 && `${c.passed} passed`,
    c.failed > 0 && `${c.failed} failed`,
    c.blocked > 0 && `${c.blocked} blocked`,
    c.inconclusive > 0 && `${c.inconclusive} inconclusive`,
    c.noVerdict > 0 && `${c.noVerdict} without a result`,
    c.active > 0 && `${c.active} still running`,
  ].filter(Boolean);
  return `${plural(c.total, "test")}: ${parts.join(", ")}`;
}

/**
 * One run of a suite (V1.2 F1): the suite's verdict once every test has finished, and each test's run. Refreshes
 * itself until the suite run has settled.
 */
export function SuiteRunPage({ suiteRunId, pollMs = SUITE_RUN_POLL_MS }: { suiteRunId: string; pollMs?: number }) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () =>
      getSuiteRun(suiteRunId).then(
        (run) => {
          if (!live) return;
          setState({ status: "ready", run });
          if (run.status === "RUNNING") timer = setTimeout(load, pollMs);
        },
        (err: unknown) => {
          if (!live) return;
          // Keep showing what was loaded; only a first load failure replaces the page.
          setState((s) => (s.status === "ready" ? s : { status: "error", message: messageOf(err) }));
          if (live) timer = setTimeout(load, pollMs * 3);
        },
      );
    void load();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [suiteRunId, pollMs, attempt]);

  if (state.status === "loading") {
    return (
      <p className="text-muted-foreground" role="status">
        Loading the suite run…
      </p>
    );
  }
  if (state.status === "error") {
    return (
      <div role="alert" className="banner banner-error">
        <Icon name="warning" />
        <div>
          <p className="banner-title">The suite run couldn&apos;t be loaded</p>
          <p>{state.message}</p>
          <div className="actions flex flex-wrap items-center gap-2">
            <Button variant="outline" type="button" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const { run } = state;
  async function cancel() {
    setCancelling(true);
    setCancelError(null);
    try {
      setState({ status: "ready", run: await cancelSuiteRun(run.id) });
    } catch (err) {
      setCancelError(messageOf(err, "The suite run couldn't be cancelled."));
    } finally {
      setCancelling(false);
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-7">
      <header className="stack-tight flex min-w-0 flex-col gap-3">
        <nav aria-label="Breadcrumb" className="breadcrumb">
          <ol>
            <li>
              <a href="/suites">Suites</a>
            </li>
            <li>
              <a href={`/suites/${encodeURIComponent(run.suiteId)}`}>{run.suiteName}</a>
            </li>
            <li aria-current="page">Run {formatWhen(run.createdAt)}</li>
          </ol>
        </nav>
        <h1 className="page-title">{run.suiteName}</h1>
        <div className="flex flex-wrap items-center gap-2 text-[0.8125rem] text-muted-foreground">
          <SuiteRunOutcome run={run} />
          <span className="pl-1">
            {TRIGGER_LABEL[run.trigger]}
            {run.owner ? ` by ${run.owner.name}` : ""} · <time dateTime={run.createdAt}>{formatWhen(run.createdAt)}</time>
          </span>
        </div>
        {(run.ci || run.startedWithToken) && (
          <p className="text-muted-foreground">
            {run.startedWithToken && <>With the API token “{run.startedWithToken.name}”</>}
            {run.startedWithToken && run.ci && " · "}
            {run.ci && (
              <>
                {run.ci.runUrl ? (
                  <a href={run.ci.runUrl} rel="noopener noreferrer" target="_blank">
                    CI job <Icon name="external" />
                  </a>
                ) : (
                  "CI job"
                )}
                {run.ci.repository && ` for ${run.ci.repository}`}
                {run.ci.ref && ` · ${run.ci.ref.replace(/^refs\/heads\//, "")}`}
                {run.ci.sha && <span className="font-mono"> · {run.ci.sha.slice(0, 7)}</span>}
              </>
            )}
          </p>
        )}
        <p role="status" aria-live="polite">
          {countsText(run)}
        </p>
        {run.status === "COMPLETED" && (
          <div className="actions flex flex-wrap items-center gap-2">
            <Button asChild variant="outline">
              <a href={`/api/v1/suite-runs/${encodeURIComponent(run.id)}/junit.xml`} download>
                <Icon name="download" />
                Download JUnit XML
              </a>
            </Button>
          </div>
        )}
        {run.status === "RUNNING" && (
          <div className="actions flex flex-wrap items-center gap-2">
            <Button variant="outline" type="button" onClick={() => void cancel()} disabled={cancelling}>
              <Icon name="stop" />
              {cancelling ? "Cancelling…" : "Cancel suite run"}
            </Button>
          </div>
        )}
        {cancelError && (
          <p role="alert" className="flex items-start gap-1.5 text-sm font-medium text-destructive [&_.icon]:mt-px">
            <Icon name="error" /> {cancelError}
          </p>
        )}
      </header>

      <Card as="section" className="overflow-hidden p-0 max-[560px]:p-0" aria-labelledby="suite-children-title">
        <h2 id="suite-children-title" className="card-title mb-3.5 text-sm font-semibold text-muted-foreground px-5 pt-[18px] pb-3">
          Tests
        </h2>
        <Table className="history">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Test</TableHead>
              <TableHead scope="col">Result</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {run.children.map((c) => (
              <TableRow key={c.runId}>
                <TableCell className="history-main">
                  <a className="row-link" href={`/runs/${encodeURIComponent(c.runId)}`}>
                    {c.title || displayUrl(c.targetUrl)}
                  </a>
                  <span className="history-host">{displayUrl(c.targetUrl)}</span>
                </TableCell>
                <TableCell className="history-result">
                  {c.verdict ? (
                    <VerdictBadge verdict={c.verdict} />
                  ) : (
                    <LifecycleBadge lifecycle={c.lifecycle} />
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
