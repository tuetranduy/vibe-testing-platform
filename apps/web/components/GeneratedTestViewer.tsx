"use client";

import type { NormalizedRequirement, TestReport } from "@platform/contracts";
import { Fragment, useId, useMemo } from "react";
import { highlightLines } from "../lib/highlight";
import { Icon } from "./Icon";
import { formatDuration } from "./report-format";

interface Props {
  test: NonNullable<TestReport["generatedTest"]>;
  playwright: TestReport["playwright"];
  requirement: NormalizedRequirement | null;
}

const RERUN_TEXT = { PASSED: "passed", FAILED: "failed", ERRORED: "errored" } as const;

/**
 * The generated Playwright test, read-only and syntax-highlighted. The source is rendered as React
 * text nodes (lib/highlight.ts), so markup inside it is shown as text and never interpreted.
 */
export function GeneratedTestViewer({ test, playwright, requirement }: Props) {
  const titleId = useId();
  const lines = useMemo(() => highlightLines(test.source), [test.source]);
  const statement = (id: string) => requirement?.criteria.find((c) => c.id === id)?.statement;

  return (
    <section className="card stack-tight" aria-labelledby={titleId}>
      <div className="card-head">
        <h2 id={titleId}>Generated Playwright test</h2>
        <p className="muted">
          {playwright
            ? `Rerun ${RERUN_TEXT[playwright.status]} in ${formatDuration(playwright.durationMs)}. Results it confirmed are marked “Confirmed by rerun”.`
            : "The generated test was not rerun."}
        </p>
      </div>

      <p>
        <strong>Covers:</strong> {test.compiledCriteria.length > 0 ? test.compiledCriteria.join(", ") : "no criteria"}
      </p>

      {test.notCompiled.length > 0 && (
        <div className="stack-tight">
          <h3 className="subhead">Not in the test</h3>
          <ul className="not-compiled" aria-label="Criteria not in the test">
            {test.notCompiled.map((n) => (
              <li key={n.criterionId}>
                <span className="ref" title={statement(n.criterionId)}>
                  {n.criterionId}
                </span>
                <span>{n.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {test.notes.length > 0 && (
        <div className="note note-warning">
          <p className="note-title">
            <Icon name="warning" /> Notes
          </p>
          <ul>
            {test.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="code-block" role="region" aria-label="Generated test source" tabIndex={0}>
        <pre>
          <code>
            {lines.map((tokens, i) => (
              <Fragment key={i}>
                <span className="code-line">
                  {tokens.map((t, j) => (
                    <span key={j} className={`tok-${t.type}`}>
                      {t.value}
                    </span>
                  ))}
                </span>
                {i < lines.length - 1 && "\n"}
              </Fragment>
            ))}
          </code>
        </pre>
      </div>
    </section>
  );
}
