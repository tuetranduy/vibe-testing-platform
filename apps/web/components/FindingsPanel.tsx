"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { ExploratoryFinding, FindingStatus } from "@platform/contracts";
import { useEffect, useState } from "react";
import { dismissFinding, getFindings, reproduceFinding } from "../lib/api";
import { Icon } from "./Icon";

const STATUS: Record<FindingStatus, { label: string; className: string }> = {
  HYPOTHESIS: { label: "Not yet confirmed", className: "bg-(--info-bg) text-(--info)" },
  REPRODUCED: { label: "Reproduced", className: "bg-(--warning-bg) text-(--warning)" },
  DISMISSED: { label: "Dismissed", className: "bg-muted text-muted-foreground" },
  BLOCKED: { label: "Reproduction blocked", className: "bg-muted text-muted-foreground" },
  INCONCLUSIVE: { label: "Inconclusive", className: "bg-muted text-muted-foreground" },
};

const REASON: Partial<Record<ExploratoryFinding["statusReason"], string>> = {
  reproduction_running: "Its reproduction run has not finished yet.",
  dismissed_by_reviewer: "Dismissed in review.",
  not_reproduced: "The independent reproduction passed: the problem was not seen again.",
  reproduced: "The independent reproduction failed the expected behavior: the problem was seen again.",
  reproduction_blocked: "The reproduction could not reach the page or control.",
  reproduction_inconclusive: "The reproduction did not decide.",
  reproduction_failed_to_run: "The reproduction run ended before it decided.",
};

interface Props {
  runId: string;
  navigate?: (url: string) => void;
}

/**
 * Phase C: what Browser Use saw that looks wrong. Every item is a hypothesis, kept apart from this run's verified
 * results; only an independent reproduction run (or a dismissal) changes its status.
 */
export function FindingsPanel({ runId, navigate = (url) => window.location.assign(url) }: Props) {
  const [findings, setFindings] = useState<ExploratoryFinding[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getFindings(runId).then((r) => live && setFindings(r.findings), () => live && setFindings([]));
    return () => { live = false; };
  }, [runId]);

  if (!findings || findings.length === 0) return null;

  const replace = (next: ExploratoryFinding) => setFindings((all) => all?.map((f) => (f.id === next.id ? next : f)) ?? null);
  async function act(finding: ExploratoryFinding, action: "dismiss" | "reproduce") {
    if (busy) return;
    setBusy(finding.id);
    setError(null);
    try {
      if (action === "dismiss") replace(await dismissFinding(runId, finding.id));
      else {
        const { run } = await reproduceFinding(runId, finding.id);
        navigate(`/runs/${encodeURIComponent(run.runId)}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn’t work. Try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card as="section" className="flex min-w-0 flex-col gap-3" aria-labelledby="findings-title">
      <div className="flex flex-col gap-1.5">
        <h2 id="findings-title" className="text-sm font-semibold">Exploratory findings (unverified)</h2>
        <p className="text-sm text-muted-foreground">
          Things Browser Use saw that look wrong. They are not test results and do not change this run’s verdict. Reproduce one to
          check it with a new, independently verified test.
        </p>
      </div>
      {error && <p className="text-sm font-medium text-destructive" role="alert">{error}</p>}
      <ul className="flex flex-col gap-3">
        {findings.map((f) => {
          const status = STATUS[f.status];
          const open = f.status === "HYPOTHESIS" && f.statusReason === "not_reviewed";
          return (
            <li key={f.id} className="flex flex-col gap-1.5 border-t pt-3 first:border-t-0 first:pt-0" aria-label={f.title}>
              <div className="flex flex-wrap items-center gap-2">
                <strong>{f.title}</strong>
                <Badge variant="outline" className={`min-h-6 border-transparent ${status.className}`}>{status.label}</Badge>
                <span className="text-xs text-muted-foreground">{f.severity} impact · <code>{f.path}</code></span>
              </div>
              <p className="text-sm">Seen: {f.observation}</p>
              <p className="text-sm text-muted-foreground">Expected: {f.expected}</p>
              {REASON[f.statusReason] && <p className="text-sm text-muted-foreground">{REASON[f.statusReason]}</p>}
              {f.recurrence && f.recurrence.otherRuns > 0 && (
                <p className="text-sm text-muted-foreground">
                  Also seen in {f.recurrence.otherRuns} other {f.recurrence.otherRuns === 1 ? "run" : "runs"}
                  {f.recurrence.reproducedElsewhere ? "; reproduced there" : f.recurrence.dismissedElsewhere ? "; dismissed there" : ""}.
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                {open && <Button size="sm" disabled={busy !== null} onClick={() => void act(f, "reproduce")}><Icon name="restart" /> Reproduce</Button>}
                {f.reproductionRunId && (
                  <Button size="sm" variant="outline" asChild><a href={`/runs/${encodeURIComponent(f.reproductionRunId)}`}>Open reproduction</a></Button>
                )}
                {f.status !== "REPRODUCED" && f.status !== "DISMISSED" && f.statusReason !== "reproduction_running" && (
                  <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void act(f, "dismiss")}>Dismiss</Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
