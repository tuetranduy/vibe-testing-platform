"use client";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useRef, useState } from "react";
import { rerunRun } from "../lib/api";
import { newIdempotencyKey } from "../lib/uuid";
import { Icon } from "./Icon";

interface Props {
  runId: string;
  secretNames: readonly string[];
  compiledCount: number;
  destructive?: boolean;
  navigate?: (url: string) => void;
}

/** Saved tests can run directly. Older tests requiring retired manual inputs start through the new test flow. */
export function RerunPanel({ runId, secretNames, compiledCount, destructive = false, navigate = (url) => window.location.assign(url) }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const key = useRef<string | null>(null);

  async function start() {
    if (pending) return;
    setPending(true);
    setError(null);
    key.current ??= newIdempotencyKey();
    try {
      const created = await rerunRun(runId, destructive ? { confirmDestructiveActions: true } : {}, key.current);
      navigate(`/runs/${encodeURIComponent(created.runId)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The rerun couldn’t be started.");
      setPending(false);
    }
  }

  return <Card as="section" className="flex min-w-0 flex-col gap-5" aria-labelledby="rerun-title">
    <div className="flex flex-col gap-1.5 [&>.text-muted-foreground]:max-w-[68ch]"><h2 id="rerun-title" className="card-title mb-3.5 text-sm font-semibold text-muted-foreground"><Icon name="restart" /> Run this test again</h2><p className="text-muted-foreground">Replay the saved test’s {compiledCount} checks without another planning step.</p></div>
    {error && <p className="flex items-start gap-1.5 text-sm font-medium text-destructive [&_.icon]:mt-px" role="alert">{error}</p>}
    {secretNames.length > 0 ? <div className="stack-tight flex min-w-0 flex-col gap-3"><p className="text-muted-foreground">This saved test uses an older setup. Start a fresh test with the same instructions.</p><Button asChild variant="outline"><a href={`/runs/new?from=${encodeURIComponent(runId)}`}>Create a fresh test<Icon name="arrow" /></a></Button></div>
      : <div className="actions flex flex-wrap items-center gap-2"><Button variant="outline" type="button" disabled={pending} onClick={() => void start()}>{pending ? "Starting…" : "Rerun saved test"}</Button></div>}

  </Card>;
}
