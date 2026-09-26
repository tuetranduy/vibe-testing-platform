"use client";

import { isTerminalLifecycle, type RunLifecycle, type TestRunSummary } from "@platform/contracts";
import { useCallback, useEffect, useReducer, useState } from "react";
import { ApiRequestError, cancelRun, getRun, type ConfirmResult } from "../lib/api";
import { initialProgress, lifecycleRank, progressReducer, type ProgressState } from "../lib/progress-reducer";
import { connectRunEvents, type ConnectionStatus } from "../lib/run-events";
import { CriteriaReview } from "./CriteriaReview";
import { Disclosure } from "./Disclosure";
import { Icon, type IconName } from "./Icon";
import { LiveEvidence } from "./LiveEvidence";
import { RunProgress } from "./RunProgress";
import { RunReport } from "./RunReport";
import { RunTimeline } from "./RunTimeline";
import { CANCEL_REASON_TEXT, ERROR_CATEGORY_LABEL, LIFECYCLE_LABEL, VERDICT_LABEL } from "./format";

/** After analysis completes, how long to poll the run summary for AWAITING_CONFIRMATION. */
const SETTLE_POLL_MS = 750;
const SETTLE_POLL_TRIES = 20;

/**
 * The lifecycle to render. The summary is authoritative when loaded, but events move faster: every
 * event carries the lifecycle at publish time, a confirmation means execution has begun, and a
 * terminal event ends the run.
 */
function viewLifecycle(summary: TestRunSummary, progress: ProgressState): RunLifecycle {
  const o = progress.outcome;
  if (o) return o.kind === "completed" ? "COMPLETED" : o.kind === "cancelled" ? "CANCELLED" : "ERRORED";
  if (isTerminalLifecycle(summary.lifecycle)) return summary.lifecycle;
  let l = summary.lifecycle;
  if (progress.latestStage && !isTerminalLifecycle(progress.latestStage) && lifecycleRank(progress.latestStage) > lifecycleRank(l)) {
    l = progress.latestStage;
  }
  if (progress.criteriaConfirmed && lifecycleRank(l) < lifecycleRank("PLANNING")) l = "PLANNING";
  return l;
}

const STATUS_ICON = (l: RunLifecycle): IconName =>
  l === "COMPLETED" ? "check" : l === "ERRORED" ? "error" : l === "CANCELLED" ? "stop" : l === "AWAITING_CONFIRMATION" ? "info" : "current";

type CancelState = "idle" | "confirming" | "pending" | "requested";

export function RunView({ runId }: { runId: string }) {
  const [summary, setSummary] = useState<TestRunSummary | null>(null);
  const [loadError, setLoadError] = useState<{ notFound: boolean; message: string } | null>(null);
  const [progress, dispatch] = useReducer(progressReducer, undefined, initialProgress);
  const [connection, setConnection] = useState<ConnectionStatus>("connecting");
  const [confirmation, setConfirmation] = useState<ConfirmResult | null>(null);
  const [cancel, setCancel] = useState<CancelState>("idle");
  const [cancelError, setCancelError] = useState<string | null>(null);
  const loaded = summary !== null;

  const refresh = useCallback(async () => {
    const s = await getRun(runId);
    setSummary(s);
    return s;
  }, [runId]);

  // 1. The run summary.
  useEffect(() => {
    let live = true;
    getRun(runId).then(
      (s) => live && setSummary(s),
      (err: unknown) =>
        live &&
        setLoadError({
          notFound: err instanceof ApiRequestError && err.status === 404,
          message: err instanceof Error ? err.message : "The run couldn't be loaded.",
        }),
    );
    return () => {
      live = false;
    };
  }, [runId]);

  // 2. The live event stream, from the start of the run (the reducer rebuilds everything from it).
  useEffect(() => {
    if (!loaded) return;
    const conn = connectRunEvents({
      runId,
      onEvent: dispatch,
      onStatus: setConnection,
      shouldReconnect: async () => {
        try {
          return !isTerminalLifecycle((await refresh()).lifecycle);
        } catch {
          return true;
        }
      },
    });
    return () => conn.close();
  }, [runId, loaded, refresh]);

  // 3. Analysis finished without auto-confirmation: the move to AWAITING_CONFIRMATION has no event
  //    of its own, so poll the summary briefly until it lands.
  const analysisDone = progress.stages.ANALYZING_REQUIREMENT === "done";
  const summaryLifecycle = summary?.lifecycle;
  useEffect(() => {
    if (!analysisDone || progress.criteriaConfirmed || progress.outcome) return;
    if (summaryLifecycle !== "QUEUED" && summaryLifecycle !== "ANALYZING_REQUIREMENT") return;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let live = true;
    const poll = async () => {
      tries++;
      try {
        const s = await getRun(runId);
        if (!live) return;
        setSummary(s);
        if (s.lifecycle !== "QUEUED" && s.lifecycle !== "ANALYZING_REQUIREMENT") return;
      } catch {
        /* retry below */
      }
      if (live && tries < SETTLE_POLL_TRIES) timer = setTimeout(poll, SETTLE_POLL_MS);
    };
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [analysisDone, progress.criteriaConfirmed, progress.outcome, summaryLifecycle, runId]);

  // 4. The run ended: pick up its final summary (verdict, finish time).
  const ended = progress.outcome !== null;
  useEffect(() => {
    if (ended) refresh().catch(() => {});
  }, [ended, refresh]);

  const onConfirmed = useCallback((result: ConfirmResult) => {
    setConfirmation(result);
    setSummary((s) => (s && s.lifecycle === "AWAITING_CONFIRMATION" ? { ...s, lifecycle: "PLANNING" } : s));
  }, []);

  async function requestCancel() {
    setCancel("pending");
    setCancelError(null);
    try {
      const s = await cancelRun(runId);
      setSummary(s);
      setCancel(isTerminalLifecycle(s.lifecycle) ? "idle" : "requested");
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === "RUN_TERMINAL") {
        setCancel("idle");
        refresh().catch(() => {});
        return;
      }
      setCancel("idle");
      setCancelError(err instanceof Error ? err.message : "The run couldn't be cancelled.");
    }
  }

  if (loadError) {
    return (
      <section className="stack" aria-labelledby="run-error-title">
        <h1 id="run-error-title">{loadError.notFound ? "Run not found" : "The run couldn't be loaded"}</h1>
        <p className="muted">{loadError.notFound ? "Check the link, or start a new test." : loadError.message}</p>
        <p>
          <a className="button button-secondary" href="/runs/new">
            New test
          </a>
        </p>
      </section>
    );
  }
  if (!summary) {
    return (
      <p className="muted" role="status">
        Loading run…
      </p>
    );
  }

  const lifecycle = viewLifecycle(summary, progress);
  const terminal = isTerminalLifecycle(lifecycle);
  const analyzing = lifecycle === "QUEUED" || lifecycle === "ANALYZING_REQUIREMENT";

  return (
    <div className="stack">
      <header className="run-header">
        <div className="run-header-main">
          <p className="eyebrow">Test run · {summary.runId}</p>
          <h1 className="run-target">{summary.targetUrl}</h1>
          <p className="muted run-requirement">{summary.requirementPreview}</p>
        </div>
        <div className="run-header-side">
          <span className={`status status-${lifecycle.toLowerCase()}`}>
            <Icon name={STATUS_ICON(lifecycle)} /> {LIFECYCLE_LABEL[lifecycle]}
          </span>
          {!terminal && cancel !== "confirming" && (
            <button
              type="button"
              className="button button-danger-quiet"
              onClick={() => setCancel("confirming")}
              disabled={cancel === "pending" || cancel === "requested"}
            >
              {cancel === "idle" ? "Cancel run" : "Cancelling…"}
            </button>
          )}
        </div>
      </header>

      {!terminal && cancel === "confirming" && (
        <div role="group" aria-labelledby="cancel-title" className="banner banner-warning">
          <Icon name="warning" />
          <div>
            <p id="cancel-title" className="banner-title">
              Cancel this run?
            </p>
            <p>The run stops at its next step. Evidence captured so far is kept.</p>
            <div className="actions">
              <button type="button" className="button button-danger" onClick={requestCancel}>
                Yes, cancel run
              </button>
              <button type="button" className="button button-secondary" onClick={() => setCancel("idle")} autoFocus>
                Keep running
              </button>
            </div>
          </div>
        </div>
      )}
      {cancelError && (
        <div role="alert" className="banner banner-error">
          <Icon name="warning" />
          <div>
            <p className="banner-title">The run couldn&apos;t be cancelled</p>
            <p>{cancelError}</p>
          </div>
        </div>
      )}
      {!terminal && (connection === "reconnecting" || connection === "failed") && (
        <p className="connection" role="status">
          <Icon name="warning" />{" "}
          {connection === "reconnecting" ? "Connection lost — reconnecting…" : "Live updates are unavailable. Reload the page to retry."}
        </p>
      )}

      {analyzing ? (
        <section className="card analyzing" aria-labelledby="analyzing-title">
          <span className="spinner" aria-hidden="true" />
          <div>
            <h2 id="analyzing-title">Analyzing your requirement</h2>
            <p className="muted">
              Turning it into acceptance criteria you can review before anything runs. This usually takes under a minute.
            </p>
          </div>
        </section>
      ) : lifecycle === "AWAITING_CONFIRMATION" ? (
        <CriteriaReview runId={runId} onConfirmed={onConfirmed} />
      ) : terminal ? (
        <>
          <RunReport
            runId={runId}
            artifacts={progress.artifacts}
            steps={progress.steps}
            cancelReason={progress.outcome?.kind === "cancelled" ? progress.outcome.reason : summary.cancelReason}
            fallback={<Outcome lifecycle={lifecycle} summary={summary} progress={progress} />}
          />
          <Disclosure title="Run activity" hint="The stages and timeline of this run.">
            <div className="stack">
              <RunProgress progress={progress} />
              <RunTimeline items={progress.timeline} />
            </div>
          </Disclosure>
        </>
      ) : (
        <>
          {confirmation && (
            <div role="status" aria-labelledby="confirmed-title" className="banner banner-info">
              <Icon name="check" />
              <div>
                <p id="confirmed-title" className="banner-title">
                  Criteria confirmed
                </p>
                <p>Revision {confirmation.revision} is frozen and the run is starting.</p>
                {confirmation.warnings.length > 0 && (
                  <ul>
                    {confirmation.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
          <div className="run-grid">
            <div className="stack">
              <RunProgress progress={progress} />
              <RunTimeline items={progress.timeline} />
            </div>
            <LiveEvidence runId={runId} screenshot={progress.latestScreenshot} />
          </div>
        </>
      )}
    </div>
  );
}

/** The outcome from the run summary / terminal event: shown when the report itself can't be loaded. */
function Outcome({ lifecycle, summary, progress }: { lifecycle: RunLifecycle; summary: TestRunSummary; progress: ProgressState }) {
  const o = progress.outcome;
  if (lifecycle === "COMPLETED") {
    const verdict = o?.kind === "completed" ? o.verdict : summary.verdict;
    return (
      <section className="banner banner-info outcome" aria-labelledby="outcome-title">
        <Icon name="check" />
        <div>
          <h2 id="outcome-title" className="banner-title">
            Run completed
          </h2>
          {verdict && <p className="verdict">Verdict: {VERDICT_LABEL[verdict]}</p>}
        </div>
      </section>
    );
  }
  if (lifecycle === "CANCELLED") {
    const reason = o?.kind === "cancelled" ? o.reason : summary.cancelReason;
    return (
      <section className="banner banner-warning outcome" aria-labelledby="outcome-title">
        <Icon name="stop" />
        <div>
          <h2 id="outcome-title" className="banner-title">
            Run cancelled
          </h2>
          <p>{reason ? CANCEL_REASON_TEXT[reason] : "The run was cancelled."} Evidence captured before that is kept.</p>
        </div>
      </section>
    );
  }
  const category = o?.kind === "errored" ? o.category : summary.errorCategory;
  return (
    <section className="banner banner-error outcome" aria-labelledby="outcome-title">
      <Icon name="error" />
      <div>
        <h2 id="outcome-title" className="banner-title">
          Run stopped because of an error
        </h2>
        {category && <p className="verdict">{ERROR_CATEGORY_LABEL[category]}</p>}
        <p>{o?.kind === "errored" ? o.message : "The run hit an infrastructure problem."}</p>
        <p className="muted">Infrastructure errors never count as a failed criterion.</p>
      </div>
    </section>
  );
}
