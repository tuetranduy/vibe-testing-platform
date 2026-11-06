"use client";

import type { TestRunSummary } from "@platform/contracts";
import { useEffect, useId, useState } from "react";
import { listRuns } from "../lib/api";
import { LIFECYCLE_LABEL, VERDICT_LABEL } from "./format";
import { hostOf, runTitle } from "./report-format";

const STEPS = [
  { title: "Describe", text: "Tell us where to start and what you expect." },
  { title: "Confirm", text: "Make sure the proposed checks match your intent." },
  { title: "Watch it explore", text: "Follow the browser as it checks your flow." },
  { title: "Get the evidence", text: "See what passed, what needs attention, and the evidence." },
] as const;

export function HowItWorks() {
  const titleId = useId();
  return (
    <section className="card how-card" aria-labelledby={titleId}>
      <h2 id={titleId}>From idea to evidence</h2>
      <ol className="how-steps">
        {STEPS.map((s, i) => (
          <li key={s.title} className="how-step">
            <span className="how-num" aria-hidden="true">
              {i + 1}
            </span>
            <div className="how-step-body">
              <p className="how-step-title">{s.title}</p>
              <p className="how-step-text">{s.text}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

const RECENT = 3;

const resultOf = (r: TestRunSummary) => (r.lifecycle === "COMPLETED" && r.verdict ? VERDICT_LABEL[r.verdict] : LIFECYCLE_LABEL[r.lifecycle]);

/** The latest runs, each a shortcut to a new test pre-filled from it (`/runs/new?from=`). Hidden until there are some. */
export function RecentRuns() {
  const titleId = useId();
  const [runs, setRuns] = useState<TestRunSummary[]>([]);

  useEffect(() => {
    let live = true;
    listRuns(null, RECENT).then(
      (page) => live && setRuns(page.items.slice(0, RECENT)),
      () => {}, // optional: the form works without it
    );
    return () => {
      live = false;
    };
  }, []);

  if (runs.length === 0) return null;
  return (
    <section className="card recent-card" aria-labelledby={titleId}>
      <h2 id={titleId} className="panel-title">
        Start from a recent run
      </h2>
      <ul className="recent-list">
        {runs.map((r) => (
          <li key={r.runId}>
            <a className="recent-link" href={`/runs/new?from=${encodeURIComponent(r.runId)}`}>
              <span className="visually-hidden">Start a new test from: </span>
              <span className="recent-requirement">{runTitle(r)}</span>
              <span className="recent-meta">
                {hostOf(r.targetUrl)} · {resultOf(r)}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
