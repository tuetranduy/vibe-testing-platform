"use client";

import type { SuiteRunView } from "@platform/contracts";
import { useEffect, useState } from "react";
import { cancelSuiteRun, getSuiteRun } from "../lib/api";
import { ChangeBadge, RUN_CHANGE_UI } from "./ComparisonPanel";
import { Icon } from "./Icon";
import { LIFECYCLE_LABEL } from "./format";
import { displayUrl, formatWhen, plural } from "./report-format";
import { VerdictBadge } from "./StatusBadge";
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
      <p className="muted" role="status">
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
          <div className="actions">
            <button type="button" className="button button-secondary" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
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
    <div className="stack-lg">
      <header className="stack-tight">
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
        <div className="run-meta">
          <SuiteRunOutcome run={run} />
          <span className="meta-text">
            {TRIGGER_LABEL[run.trigger]}
            {run.owner ? ` by ${run.owner.name}` : ""} · <time dateTime={run.createdAt}>{formatWhen(run.createdAt)}</time>
          </span>
        </div>
        <p role="status" aria-live="polite">
          {countsText(run)}
        </p>
        {(run.changes.regressed > 0 || run.changes.fixed > 0) && (
          <p className={run.changes.regressed > 0 ? "field-error" : "muted"}>
            <Icon name={run.changes.regressed > 0 ? "warning" : "check"} />{" "}
            {[run.changes.regressed > 0 && `${plural(run.changes.regressed, "test")} regressed`, run.changes.fixed > 0 && `${plural(run.changes.fixed, "test")} fixed`]
              .filter(Boolean)
              .join(", ")}{" "}
            since their previous run.
          </p>
        )}
        {run.status === "RUNNING" && (
          <div className="actions">
            <button type="button" className="button button-secondary" onClick={() => void cancel()} disabled={cancelling}>
              <Icon name="stop" />
              {cancelling ? "Cancelling…" : "Cancel suite run"}
            </button>
          </div>
        )}
        {cancelError && (
          <p role="alert" className="field-error">
            <Icon name="error" /> {cancelError}
          </p>
        )}
      </header>

      <section className="card card-flush" aria-labelledby="suite-children-title">
        <h2 id="suite-children-title" className="card-title card-flush-title">
          Tests
        </h2>
        <table className="history">
          <thead>
            <tr>
              <th scope="col">Test</th>
              <th scope="col">Result</th>
              <th scope="col">Since the previous run</th>
            </tr>
          </thead>
          <tbody>
            {run.children.map((c) => (
              <tr key={c.runId}>
                <td className="history-main">
                  <a className="row-link" href={`/runs/${encodeURIComponent(c.runId)}`}>
                    {c.title || displayUrl(c.targetUrl)}
                  </a>
                  <span className="history-host">{displayUrl(c.targetUrl)}</span>
                </td>
                <td className="history-result">
                  {c.verdict ? (
                    <VerdictBadge verdict={c.verdict} />
                  ) : (
                    <span className={`status status-${c.lifecycle.toLowerCase()}`}>{LIFECYCLE_LABEL[c.lifecycle]}</span>
                  )}
                </td>
                <td className="history-result">{c.change ? <ChangeBadge ui={RUN_CHANGE_UI[c.change]} /> : <span className="muted">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
