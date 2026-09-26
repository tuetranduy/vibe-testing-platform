"use client";

import { isTerminalLifecycle, type TestRunSummary } from "@platform/contracts";
import { useCallback, useEffect, useState } from "react";
import { listRuns } from "../lib/api";
import { Icon } from "./Icon";
import { ERROR_CATEGORY_LABEL, LIFECYCLE_LABEL } from "./format";
import { durationBetween, formatDateTime, formatDuration, hostOf } from "./report-format";
import { VerdictBadge } from "./StatusBadge";

type Load = { status: "loading" } | { status: "error"; message: string } | { status: "ready" };

const message = (err: unknown) => (err instanceof Error ? err.message : "Something went wrong.");

/** The run history (`GET /v1/test-runs`), newest first, 50 at a time with a cursor. */
export function RunHistory() {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [items, setItems] = useState<TestRunSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoad({ status: "loading" });
    listRuns().then(
      (page) => {
        if (!live) return;
        setItems(page.items);
        setNextCursor(page.nextCursor);
        setLoad({ status: "ready" });
      },
      (err: unknown) => live && setLoad({ status: "error", message: message(err) }),
    );
    return () => {
      live = false;
    };
  }, [attempt]);

  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await listRuns(nextCursor);
      // A run can appear on two pages if runs were created meanwhile; keep the first copy.
      setItems((prev) => {
        const seen = new Set(prev.map((r) => r.runId));
        return [...prev, ...page.items.filter((r) => !seen.has(r.runId))];
      });
      setNextCursor(page.nextCursor);
    } catch (err) {
      setMoreError(message(err));
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor]);

  if (load.status === "loading") {
    return (
      <p className="muted" role="status">
        Loading test runs…
      </p>
    );
  }
  if (load.status === "error") {
    return (
      <div role="alert" className="banner banner-error">
        <Icon name="warning" />
        <div>
          <p className="banner-title">We couldn&apos;t load the test runs</p>
          <p>{load.message}</p>
          <div className="actions">
            <button type="button" className="button button-secondary" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <section className="card empty-state" aria-labelledby="empty-title">
        <Icon name="file" />
        <h2 id="empty-title">No test runs yet</h2>
        <p className="muted">Start a test: give a URL and describe what should work. Its report will be listed here.</p>
        <a className="button button-primary" href="/runs/new">
          New test
        </a>
      </section>
    );
  }

  return (
    <div className="stack">
      <div className="card table-card">
        <table className="history" role="table">
          <caption className="visually-hidden">Test runs</caption>
          <thead role="rowgroup">
            <tr role="row">
              <th role="columnheader" scope="col">Created</th>
              <th role="columnheader" scope="col">Target</th>
              <th role="columnheader" scope="col">Requirement</th>
              <th role="columnheader" scope="col">Result</th>
              <th role="columnheader" scope="col">Duration</th>
            </tr>
          </thead>
          <tbody role="rowgroup">
            {items.map((r) => (
              <tr role="row" key={r.runId}>
                <td role="cell" className="history-created">
                  <time dateTime={r.createdAt}>{formatDateTime(r.createdAt)}</time>
                </td>
                <td role="cell" className="history-target">
                  <a className="row-link" href={`/runs/${encodeURIComponent(r.runId)}`}>
                    {hostOf(r.targetUrl)}
                  </a>
                </td>
                <td role="cell" className="history-requirement">
                  <span title={r.requirementPreview}>{r.requirementPreview}</span>
                </td>
                <td role="cell" className="history-result">
                  <RunResult run={r} />
                </td>
                <td role="cell" className="history-duration">
                  <RunDuration run={r} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {moreError && (
        <p role="alert" className="field-error">
          <Icon name="warning" /> We couldn&apos;t load more runs. {moreError}
        </p>
      )}
      {nextCursor && (
        <div className="history-more">
          <button type="button" className="button button-secondary" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}

/** The verdict for a completed run; otherwise the lifecycle (plus the error category when errored). */
function RunResult({ run }: { run: TestRunSummary }) {
  if (run.lifecycle === "COMPLETED" && run.verdict) return <VerdictBadge verdict={run.verdict} />;
  const icon = run.lifecycle === "ERRORED" ? "error" : run.lifecycle === "CANCELLED" ? "stop" : "current";
  return (
    <span className="lifecycle-cell">
      <span className={`lstatus lstatus-${run.lifecycle.toLowerCase()}`}>
        <Icon name={icon} /> {LIFECYCLE_LABEL[run.lifecycle]}
      </span>
      {run.lifecycle === "ERRORED" && run.errorCategory && <span className="muted">{ERROR_CATEGORY_LABEL[run.errorCategory]}</span>}
    </span>
  );
}

function RunDuration({ run }: { run: TestRunSummary }) {
  if (!isTerminalLifecycle(run.lifecycle)) return <span className="muted">{run.startedAt ? "Running…" : "Not started"}</span>;
  return <>{formatDuration(durationBetween(run.startedAt, run.finishedAt))}</>;
}
