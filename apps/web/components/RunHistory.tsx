"use client";

import { isTerminalLifecycle, type TestRunSummary } from "@platform/contracts";
import { useCallback, useEffect, useId, useState } from "react";
import { listRuns } from "../lib/api";
import { PROGRESS_STAGES, STAGE_LABELS, type ProgressStage } from "../lib/progress-reducer";
import { Icon, type IconName } from "./Icon";
import { ERROR_CATEGORY_LABEL, LIFECYCLE_LABEL } from "./format";
import { durationBetween, formatDuration, formatWhen, hostOf, plural } from "./report-format";
import { VerdictBadge } from "./StatusBadge";

type Load = { status: "loading" } | { status: "error"; message: string } | { status: "ready" };

const message = (err: unknown) => (err instanceof Error ? err.message : "Something went wrong.");

type FilterId = "all" | "passed" | "failed" | "attention" | "active" | "stopped";

/** Result filters over the loaded runs. Every run is in "All" and in at most one other filter. */
const FILTERS: readonly { id: FilterId; label: string; test: (r: TestRunSummary) => boolean }[] = [
  { id: "all", label: "All", test: () => true },
  { id: "passed", label: "Passed", test: (r) => r.verdict === "PASSED" },
  { id: "failed", label: "Failed", test: (r) => r.verdict === "FAILED" },
  { id: "attention", label: "Blocked or inconclusive", test: (r) => r.verdict === "BLOCKED" || r.verdict === "INCONCLUSIVE" },
  { id: "active", label: "In progress", test: (r) => !isTerminalLifecycle(r.lifecycle) },
  { id: "stopped", label: "Cancelled or errored", test: (r) => r.lifecycle === "CANCELLED" || r.lifecycle === "ERRORED" },
];

const matchesQuery = (r: TestRunSummary, query: string) => {
  const q = query.trim().toLowerCase();
  return q === "" || `${r.targetUrl} ${r.requirementPreview}`.toLowerCase().includes(q);
};

/**
 * The run history (`GET /v1/test-runs`), newest first, 50 at a time with a cursor: an overview of
 * the loaded runs' results, the run in progress, and the list with result filters and a text filter.
 */
export function RunHistory() {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [items, setItems] = useState<TestRunSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterId>("all");
  const [query, setQuery] = useState("");
  const searchId = useId();

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

  const hasRuns = load.status === "ready" && items.length > 0;
  const head = (
    <div className="page-head">
      <div className="title-block">
        <h1 className="page-title">Test runs</h1>
        <p className="page-lede">Every run, its verdict, and the evidence behind it.</p>
      </div>
      {hasRuns && (
        <div className="input-with-icon search-field">
          <label htmlFor={searchId} className="visually-hidden">
            Filter runs by website or requirement
          </label>
          <Icon name="search" />
          <input
            id={searchId}
            type="search"
            placeholder="Filter by website or requirement"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      )}
    </div>
  );

  let body;
  if (load.status === "loading") {
    body = (
      <p className="muted" role="status">
        Loading test runs…
      </p>
    );
  } else if (load.status === "error") {
    body = (
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
  } else if (items.length === 0) {
    body = (
      <section className="card empty-state" aria-labelledby="empty-title">
        <Icon name="file" />
        <h2 id="empty-title">No test runs yet</h2>
        <p className="muted">Start a test: give a URL and describe what should work. Its report will be listed here.</p>
        <a className="button button-primary" href="/runs/new">
          <Icon name="plus" />
          New test
        </a>
      </section>
    );
  } else {
    const active = FILTERS.find((f) => f.id === filter)!;
    const visible = items.filter((r) => active.test(r) && matchesQuery(r, query));
    const filtering = filter !== "all" || query.trim() !== "";
    // A filter with no runs is hidden, unless it is the one selected.
    const chips = FILTERS.map((f) => ({ ...f, count: items.filter(f.test).length })).filter((f) => f.count > 0 || f.id === filter);

    body = (
      <>
        <div className="overview">
          <ResultsOverview runs={items} />
          <RunningNow runs={items} />
        </div>

        <section className="card table-card" aria-labelledby="runs-title">
          <h2 id="runs-title" className="visually-hidden">
            All runs
          </h2>
          <div className="table-toolbar">
            <div role="group" aria-label="Show" className="filter-chips">
              {chips.map((f) => (
                <button key={f.id} type="button" className="chip" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
                  {f.label} <span className="chip-count">{f.count}</span>
                </button>
              ))}
            </div>
            <p className="toolbar-note" role="status">
              {filtering
                ? `${visible.length} of ${plural(items.length, "run")}${nextCursor ? " loaded so far" : ""}`
                : "Newest first"}
            </p>
          </div>

          {visible.length === 0 ? (
            <div className="history-nomatch">
              <p>No runs match {query.trim() ? "this filter" : "this result"}.</p>
              <button
                type="button"
                className="button button-secondary"
                onClick={() => {
                  setFilter("all");
                  setQuery("");
                }}
              >
                Show all runs
              </button>
            </div>
          ) : (
            <RunTable runs={visible} />
          )}
        </section>

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
      </>
    );
  }

  return (
    <div className="stack-lg">
      {head}
      {body}
    </div>
  );
}

function RunTable({ runs }: { runs: TestRunSummary[] }) {
  return (
    <table className="history" role="table">
      <caption className="visually-hidden">Test runs</caption>
      <thead role="rowgroup">
        <tr role="row">
          <th role="columnheader" scope="col">
            Result
          </th>
          <th role="columnheader" scope="col">
            Requirement
          </th>
          <th role="columnheader" scope="col">
            Created
          </th>
          <th role="columnheader" scope="col">
            Duration
          </th>
        </tr>
      </thead>
      <tbody role="rowgroup">
        {runs.map((r) => (
          <tr role="row" key={r.runId} className={isTerminalLifecycle(r.lifecycle) ? undefined : "history-row-active"}>
            <td role="cell" className="history-result">
              <RunResult run={r} />
            </td>
            <td role="cell" className="history-main">
              <a className="row-link" href={`/runs/${encodeURIComponent(r.runId)}`} title={r.requirementPreview}>
                {r.requirementPreview}
              </a>
              <span className="history-host">{hostOf(r.targetUrl)}</span>
            </td>
            <td role="cell" className="history-created">
              <time dateTime={r.createdAt}>{formatWhen(r.createdAt)}</time>
            </td>
            <td role="cell" className="history-duration">
              <div className="history-duration-inner">
                <RunDuration run={r} />
                <Icon name="next" className="row-chevron" />
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const LIFECYCLE_ICON = (r: TestRunSummary): IconName =>
  r.lifecycle === "ERRORED" ? "error" : r.lifecycle === "CANCELLED" ? "stop" : r.lifecycle === "AWAITING_CONFIRMATION" ? "info" : "current";

/** The verdict for a completed run; otherwise the lifecycle (plus the error category when errored). */
function RunResult({ run }: { run: TestRunSummary }) {
  if (run.lifecycle === "COMPLETED" && run.verdict) return <VerdictBadge verdict={run.verdict} />;
  return (
    <span className="lifecycle-cell">
      <span className={`lstatus lstatus-${run.lifecycle.toLowerCase()}`}>
        <Icon name={LIFECYCLE_ICON(run)} /> {LIFECYCLE_LABEL[run.lifecycle]}
      </span>
      {run.lifecycle === "ERRORED" && run.errorCategory && <span className="muted">{ERROR_CATEGORY_LABEL[run.errorCategory]}</span>}
    </span>
  );
}

function RunDuration({ run }: { run: TestRunSummary }) {
  if (!isTerminalLifecycle(run.lifecycle)) return <span>{run.startedAt ? "Running…" : "Not started"}</span>;
  return <span className="mono">{formatDuration(durationBetween(run.startedAt, run.finishedAt))}</span>;
}

/** How the loaded runs ended: passed out of those with a verdict, and a bar of every result. */
function ResultsOverview({ runs }: { runs: TestRunSummary[] }) {
  const titleId = useId();
  const count = (verdict: TestRunSummary["verdict"]) => runs.filter((r) => r.verdict === verdict).length;
  const segments = [
    { key: "pass", n: count("PASSED"), word: "passed" },
    { key: "fail", n: count("FAILED"), word: "failed" },
    { key: "blocked", n: count("BLOCKED"), word: "blocked" },
    { key: "inconclusive", n: count("INCONCLUSIVE"), word: "inconclusive" },
  ] as const;
  const finished = segments.reduce((sum, s) => sum + s.n, 0);
  const other = runs.length - finished;

  return (
    <section className="card mix-card" aria-labelledby={titleId}>
      <div className="mix-head">
        <h2 id={titleId} className="panel-title">
          Results of the last {plural(runs.length, "run")}
        </h2>
        <p className="mix-total">{finished} with a verdict</p>
      </div>
      <p className="mix-figure">
        {finished === 0 ? (
          <span className="mix-caption">No run has a verdict yet.</span>
        ) : (
          <>
            <span className="mix-number">
              {segments[0].n} of {finished}
            </span>
            <span className="mix-caption">finished {finished === 1 ? "run" : "runs"} passed</span>
          </>
        )}
      </p>
      {/* The legend below says the same in words. */}
      <div className="mix-bar" aria-hidden="true">
        {segments.map((s) => s.n > 0 && <span key={s.key} className={`mix-seg mix-seg-${s.key}`} style={{ flexGrow: s.n }} />)}
        {other > 0 && <span className="mix-seg" style={{ flexGrow: other }} />}
      </div>
      <ul className="mix-legend">
        {segments.map(
          (s) =>
            s.n > 0 && (
              <li key={s.key}>
                <span className={`legend-swatch mix-seg-${s.key}`} />
                {s.n} {s.word}
              </li>
            ),
        )}
        {other > 0 && (
          <li>
            <span className="legend-swatch" />
            {other} running, cancelled or errored
          </li>
        )}
      </ul>
    </section>
  );
}

/** The newest run that is still going (a link to follow it), or a prompt to start one. */
function RunningNow({ runs }: { runs: TestRunSummary[] }) {
  const titleId = useId();
  const active = runs.filter((r) => !isTerminalLifecycle(r.lifecycle));
  const run = active[0];

  if (!run) {
    return (
      <section className="ink running-card" aria-labelledby={titleId}>
        <p className="running-label">Nothing running</p>
        <h2 id={titleId} className="running-idle-title">
          Test something new
        </h2>
        <p className="running-idle-text">Describe what should work, then follow a real browser as it checks it.</p>
        <a className="button button-on-ink" href="/runs/new">
          <Icon name="plus" />
          New test
        </a>
      </section>
    );
  }

  const stage = PROGRESS_STAGES.indexOf(run.lifecycle as ProgressStage); // -1 while queued
  const waiting = run.lifecycle === "AWAITING_CONFIRMATION";
  return (
    <a className="ink running-card" href={`/runs/${encodeURIComponent(run.runId)}`}>
      <span className="running-label">
        <span className="live-dot" aria-hidden="true" />
        {waiting ? "Waiting for you" : "Running now"}
      </span>
      <span className="running-title">{run.requirementPreview}</span>
      <span className="running-foot">
        <span className="running-meta">
          <span>{waiting ? "Confirm the criteria to start" : stage >= 0 ? STAGE_LABELS[run.lifecycle as ProgressStage] : "Queued"}</span>
          <span>{stage >= 0 ? `Stage ${stage + 1} of ${PROGRESS_STAGES.length}` : hostOf(run.targetUrl)}</span>
        </span>
        <span className="mini-stages" aria-hidden="true">
          {PROGRESS_STAGES.map((s, i) => (
            <span key={s} className={`mini-stage${i < stage ? " mini-stage-done" : i === stage ? " mini-stage-current" : ""}`} />
          ))}
        </span>
        {active.length > 1 && <span className="running-more">+{active.length - 1} more in progress</span>}
      </span>
    </a>
  );
}
