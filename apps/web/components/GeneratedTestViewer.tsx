"use client";

import type { NormalizedRequirement, TestReport } from "@platform/contracts";
import { Fragment, useEffect, useId, useMemo, useState } from "react";
import { highlightLines } from "../lib/highlight";
import { Icon } from "./Icon";
import { formatDuration } from "./report-format";

interface Props {
  test: NonNullable<TestReport["generatedTest"]>;
  playwright: TestReport["playwright"];
  requirement: NormalizedRequirement | null;
}

const RERUN_TEXT = { PASSED: "passed", FAILED: "failed", ERRORED: "errored" } as const;

/** The compiler writes the test to this file (with helpers.ts and run-data.json beside it). */
const SPEC_FILE = "run.spec.ts";

/**
 * The generated Playwright test, read-only and syntax-highlighted. The source is rendered as React
 * text nodes (lib/highlight.ts), so markup inside it is shown as text and never interpreted.
 */
export function GeneratedTestViewer({ test, playwright, requirement }: Props) {
  const titleId = useId();
  const lines = useMemo(() => highlightLines(test.source), [test.source]);
  const statement = (id: string) => requirement?.criteria.find((c) => c.id === id)?.statement;

  return (
    <section className="code-card" aria-labelledby={titleId}>
      <div className="section-head">
        <h2 id={titleId} className="section-title">
          Generated Playwright test
        </h2>
        <p className="muted">
          {playwright
            ? `Rerun ${RERUN_TEXT[playwright.status]} in ${formatDuration(playwright.durationMs)}. Results it confirmed are marked “Confirmed by rerun”.`
            : "The generated test was not rerun."}
        </p>
      </div>

      {(test.notCompiled.length > 0 || test.notes.length > 0) && (
        <div className="card stack-tight">
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
        </div>
      )}

      <div className="ink code-panel">
        <div className="code-head">
          <p className="code-title">
            <span className="code-file">{SPEC_FILE}</span>
            <span className="code-covers">Covers {test.compiledCriteria.length > 0 ? test.compiledCriteria.join(", ") : "no criteria"}</span>
          </p>
          <CopyButton text={test.source} />
        </div>
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
      </div>
    </section>
  );
}

/** Copies the source; the label says whether it worked (the clipboard is unavailable on insecure origins). */
function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 2500);
    return () => clearTimeout(timer);
  }, [state]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
  }

  return (
    <button type="button" className="copy-button" onClick={copy}>
      <Icon name={state === "copied" ? "check" : "copy"} />
      <span aria-live="polite">{state === "copied" ? "Copied" : state === "failed" ? "Couldn't copy" : "Copy"}</span>
    </button>
  );
}
