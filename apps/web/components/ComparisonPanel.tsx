"use client";

import type { CriterionChange, RunChange, RunComparison } from "@platform/contracts";
import { useEffect, useState } from "react";
import { getComparison } from "../lib/api";
import { Icon, type IconName } from "./Icon";
import { formatDuration, formatUsd, formatWhen } from "./report-format";
import { CriterionStatusBadge, VerdictBadge } from "./StatusBadge";
import { messageOf } from "./Suites";

const CHANGE_UI: Record<CriterionChange, { label: string; icon: IconName; tone: string }> = {
  regressed: { label: "Regressed", icon: "fail", tone: "fail" },
  fixed: { label: "Fixed", icon: "pass", tone: "pass" },
  changed: { label: "Changed", icon: "info", tone: "inconclusive" },
  unchanged: { label: "Unchanged", icon: "check", tone: "inconclusive" },
  added: { label: "New", icon: "plus", tone: "inconclusive" },
  removed: { label: "No longer checked", icon: "x", tone: "inconclusive" },
};

/** A whole run's change against its previous run (suite runs). */
export const RUN_CHANGE_UI: Record<RunChange, { label: string; icon: IconName; tone: string }> = {
  regressed: CHANGE_UI.regressed,
  fixed: CHANGE_UI.fixed,
  changed: CHANGE_UI.changed,
  unchanged: CHANGE_UI.unchanged,
  new: { label: "First run", icon: "plus", tone: "inconclusive" },
};

export function ChangeBadge({ ui }: { ui: { label: string; icon: IconName; tone: string } }) {
  return (
    <span className={`sbadge sbadge-${ui.tone}`}>
      <Icon name={ui.icon} /> {ui.label}
    </span>
  );
}

const ORDER: CriterionChange[] = ["regressed", "fixed", "changed", "added", "removed", "unchanged"];

type State = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; comparison: RunComparison };

/**
 * "Compared with the previous run" (V1.2 F2) on a completed run's report: the verdict then and now, and every
 * criterion whose result changed first. Another finished run of the same test can be chosen as the baseline.
 */
export function ComparisonPanel({ runId }: { runId: string }) {
  const [baseline, setBaseline] = useState<string | undefined>(undefined);
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let live = true;
    setState({ status: "loading" });
    getComparison(runId, baseline).then(
      (comparison) => live && setState({ status: "ready", comparison }),
      (err: unknown) => live && setState({ status: "error", message: messageOf(err) }),
    );
    return () => {
      live = false;
    };
  }, [runId, baseline]);

  if (state.status === "loading") {
    return (
      <p className="muted" role="status">
        Comparing with the previous run…
      </p>
    );
  }
  if (state.status === "error") {
    return (
      <p role="alert" className="field-error">
        <Icon name="error" /> The comparison couldn&apos;t be loaded: {state.message}
      </p>
    );
  }
  const c = state.comparison;
  // The first run of a test, with nothing to choose: nothing to show.
  if (!c.baseline && c.history.length === 0) return null;

  const changed = [...c.criteria].sort((a, b) => ORDER.indexOf(a.change) - ORDER.indexOf(b.change));
  const same = c.counts.unchanged === c.criteria.length && c.verdict.before === c.verdict.after;
  return (
    <section className="card stack" aria-labelledby="comparison-title">
      <div className="section-head">
        <h2 id="comparison-title" className="card-title">
          <Icon name="chart" /> {c.chosenBaseline ? "Compared with a chosen run" : "Compared with the previous run"}
        </h2>
        {c.baseline ? (
          <p className="muted">
            <a href={`/runs/${encodeURIComponent(c.baseline.runId)}`}>The run of {formatWhen(c.baseline.createdAt)}</a>
            {` · ${c.counts.regressed} regressed, ${c.counts.fixed} fixed, ${c.counts.changed} changed`}
          </p>
        ) : (
          <p className="muted">No earlier run of this test finished before this one.</p>
        )}
      </div>
      {c.baseline && (
        <>
          <div className="comparison-verdicts">
            <span className="comparison-side">
              <span className="muted">Then</span> {c.verdict.before ? <VerdictBadge verdict={c.verdict.before} /> : "—"}
            </span>
            <Icon name="arrow" />
            <span className="comparison-side">
              <span className="muted">Now</span> {c.verdict.after ? <VerdictBadge verdict={c.verdict.after} /> : "—"}
            </span>
            <span className="muted">
              {formatDuration(c.durationMs.before)} → {formatDuration(c.durationMs.after)}
              {c.costUsd.before !== null && c.costUsd.after !== null && ` · ${formatUsd(c.costUsd.before)} → ${formatUsd(c.costUsd.after)}`}
            </span>
          </div>
          {same ? (
            <p>
              <Icon name="check" /> Every criterion has the same result as before.
            </p>
          ) : (
            <ul className="comparison-list" aria-label="Criteria compared">
              {changed.map((x) => (
                <li key={`${x.change}-${x.id}`} className="comparison-row">
                  <ChangeBadge ui={CHANGE_UI[x.change]} />
                  <span className="comparison-text">
                    <span className="mono">{x.id}</span> {x.description}
                    {!x.critical && <span className="muted"> (non-critical)</span>}
                  </span>
                  <span className="comparison-statuses">
                    {x.before ? <CriterionStatusBadge status={x.before} /> : <span className="muted">—</span>}
                    <Icon name="arrow" />
                    {x.after ? <CriterionStatusBadge status={x.after} /> : <span className="muted">—</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {c.history.length > 0 && (
        <div className="field comparison-baseline">
          <label htmlFor="comparison-baseline">Compare with</label>
          <select id="comparison-baseline" value={baseline ?? ""} onChange={(e) => setBaseline(e.target.value || undefined)}>
            <option value="">The previous run</option>
            {c.history.map((h) => (
              <option key={h.runId} value={h.runId}>
                {formatWhen(h.createdAt)}
                {h.verdict ? ` — ${h.verdict.toLowerCase()}` : ""}
              </option>
            ))}
          </select>
        </div>
      )}
    </section>
  );
}
