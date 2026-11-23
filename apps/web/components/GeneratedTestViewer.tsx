"use client";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { NormalizedRequirement, TestReport } from "@platform/contracts";
import { toast } from "sonner";
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
      <div className="flex flex-col gap-1.5 [&>.text-muted-foreground]:max-w-[68ch]">
        <h2 id={titleId} className="font-heading text-2xl leading-[1.2] font-semibold tracking-[-0.015em]">
          Generated Playwright test
        </h2>
        <p className="text-muted-foreground">
          {playwright
            ? `Rerun ${RERUN_TEXT[playwright.status]} in ${formatDuration(playwright.durationMs)}. Results it confirmed are marked “Confirmed by rerun”.`
            : "The generated test was not rerun."}
        </p>
      </div>

      {(test.notCompiled.length > 0 || test.notes.length > 0) && (
        <Card className="stack-tight flex min-w-0 flex-col gap-3">
          {test.notCompiled.length > 0 && (
            <div className="stack-tight flex min-w-0 flex-col gap-3">
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
        </Card>
      )}

      <div className="ink code-panel">
        <div className="code-head">
          <p className="code-title">
            <span className="font-mono text-[0.8125rem] text-white">{SPEC_FILE}</span>
            <span className="text-[0.8125rem] text-(--ink-subtle)">Covers {test.compiledCriteria.length > 0 ? test.compiledCriteria.join(", ") : "no criteria"}</span>
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
      toast.success("Test source copied.");
    } catch {
      setState("failed");
      toast.error("Couldn’t copy the test source.");
    }
  }

  return (
    <Button variant="plain" type="button" className="copy-button" onClick={copy}>
      <Icon name={state === "copied" ? "check" : "copy"} />
      <span>{state === "copied" ? "Copied" : state === "failed" ? "Couldn't copy" : "Copy"}</span>
    </Button>
  );
}
