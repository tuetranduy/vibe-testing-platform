"use client";

import { useRef, useState, type FormEvent } from "react";
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
  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const key = useRef<string | null>(null);

  async function start(event?: FormEvent) {
    event?.preventDefault();
    if (pending) return;
    if (destructive && !confirmed) { setError("Confirm that the rerun repeats actions that change site data."); return; }
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

  return <section className="card stack" aria-labelledby="rerun-title">
    <div className="section-head"><h2 id="rerun-title" className="card-title"><Icon name="restart" /> Run this test again</h2><p className="muted">Replay the saved test’s {compiledCount} checks without another planning step.</p></div>
    {error && <p className="field-error" role="alert">{error}</p>}
    {secretNames.length > 0 ? <div className="stack-tight"><p className="muted">This saved test uses an older setup. Start a fresh test with the same instructions.</p><a className="button button-secondary" href={`/runs/new?from=${encodeURIComponent(runId)}`}>Create a fresh test<Icon name="arrow" /></a></div>
      : !open ? <div className="actions"><button type="button" className="button button-secondary" disabled={pending} onClick={() => destructive ? setOpen(true) : void start()}>{pending ? "Starting…" : "Rerun saved test"}</button></div>
      : <form className="stack" onSubmit={start} aria-busy={pending}>
        {destructive && <div className="note note-warning"><p>This saved test changes site data. Replaying it repeats those actions.</p><label className="choice"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />I understand: repeat these actions</label></div>}
        <div className="actions"><button className="button button-primary" type="submit" disabled={pending}>{pending ? "Starting…" : "Start rerun"}</button><button type="button" className="button button-secondary" disabled={pending} onClick={() => setOpen(false)}>Cancel</button></div>
      </form>}
  </section>;
}
