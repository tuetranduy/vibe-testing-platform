"use client";

import { Card } from "@/components/ui/card";
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
    <Card as="section" className="how-card" aria-labelledby={titleId}>
      <h2 id={titleId}>From idea to evidence</h2>
      <ol className="how-steps">
        {STEPS.map((s, i) => (
          <li key={s.title} className="how-step">
            <span className="how-num" aria-hidden="true">
              {i + 1}
            </span>
            <div className="flex min-w-0 flex-col gap-[3px]">
              <p className="text-[0.8rem] font-semibold text-foreground">{s.title}</p>
              <p className="text-xs leading-relaxed text-muted-foreground">{s.text}</p>
            </div>
          </li>
        ))}
      </ol>
    </Card>
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
    <Card as="section" className="flex flex-col gap-2 rounded-[18px] px-5 pt-5 pb-3" aria-labelledby={titleId}>
      <h2 id={titleId} className="panel-title">
        Start from a recent run
      </h2>
      <ul className="flex list-none flex-col p-0">
        {runs.map((r) => (
          <li key={r.runId}>
            <a className="-mx-2 flex flex-col gap-[3px] rounded-md px-3 py-2.5 text-foreground no-underline transition-colors hover:bg-(--surface-hover) hover:text-foreground" href={`/runs/new?from=${encodeURIComponent(r.runId)}`}>
              <span className="sr-only">Start a new test from: </span>
              <span className="line-clamp-2 text-sm leading-[1.4] font-medium">{runTitle(r)}</span>
              <span className="font-mono text-xs wrap-anywhere text-(--text-subtle)">
                {hostOf(r.targetUrl)} · {resultOf(r)}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </Card>
  );
}
