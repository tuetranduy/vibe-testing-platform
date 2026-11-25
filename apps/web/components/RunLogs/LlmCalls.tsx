"use client";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { LlmCallView, LlmExchange, RunLlmCalls } from "@platform/contracts";
import { useEffect, useState } from "react";
import { ApiRequestError, getLlmExchange } from "../../lib/api";
import { clock } from "./LogTimeline";

const usd = (n: number) => `$${n.toFixed(4)}`;
const num = (n: number) => n.toLocaleString("en-US");

export function LlmCallsTable({ data, onOpen }: { data: RunLlmCalls; onOpen: (call: LlmCallView) => void }) {
  if (data.calls.length === 0) return <p className="text-muted-foreground">This run made no model calls.</p>;
  return (
    <div className="min-w-0 overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Time</TableHead>
            <TableHead>Stage</TableHead>
            <TableHead>Purpose</TableHead>
            <TableHead>Model</TableHead>
            <TableHead className="text-right">Tokens in / out</TableHead>
            <TableHead className="text-right">Cost</TableHead>
            <TableHead className="text-right">Time taken</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>
              <span className="sr-only">Prompt</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.calls.map((c) => (
            <TableRow key={c.id}>
              <TableCell className="tabular-nums">{clock(c.time)}</TableCell>
              <TableCell>{c.stage}</TableCell>
              <TableCell>{c.purpose ?? "—"}</TableCell>
              <TableCell>{c.model}</TableCell>
              <TableCell className="text-right tabular-nums">
                {num(c.inputTokens)} / {num(c.outputTokens)}
              </TableCell>
              <TableCell className="text-right tabular-nums">{usd(c.estimatedCostUsd)}</TableCell>
              <TableCell className="text-right tabular-nums">{(c.latencyMs / 1000).toFixed(1)} s</TableCell>
              <TableCell>{c.status}</TableCell>
              <TableCell>
                {c.exchange === "expired" ? (
                  <span className="text-sm text-muted-foreground">Expired</span>
                ) : (
                  <Button variant="ghost" size="sm" type="button" onClick={() => onOpen(c)}>
                    View prompt
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
          <TableRow>
            <TableCell colSpan={4} className="font-medium">
              {num(data.totals.calls)} calls
            </TableCell>
            <TableCell className="text-right font-medium tabular-nums">
              {num(data.totals.inputTokens)} / {num(data.totals.outputTokens)}
            </TableCell>
            <TableCell className="text-right font-medium tabular-nums">{usd(data.totals.estimatedCostUsd)}</TableCell>
            <TableCell colSpan={3} />
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}

type ExchangeState = { status: "loading" } | { status: "ready"; exchange: LlmExchange } | { status: "expired" } | { status: "error"; message: string };

const contentText = (content: unknown) => (typeof content === "string" ? content : JSON.stringify(content, null, 2));

function Block({ label, text }: { label: string; text: string }) {
  return (
    <section className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{label}</h3>
        <Button variant="ghost" size="sm" type="button" onClick={() => void navigator.clipboard?.writeText(text).catch(() => {})}>
          Copy
        </Button>
      </div>
      <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap break-words">{text}</pre>
    </section>
  );
}

export function LlmExchangeDialog({ runId, call, onClose }: { runId: string; call: LlmCallView; onClose: () => void }) {
  const [state, setState] = useState<ExchangeState>({ status: "loading" });
  useEffect(() => {
    let live = true;
    getLlmExchange(runId, call.id).then(
      (exchange) => live && setState({ status: "ready", exchange }),
      (err: unknown) =>
        live &&
        setState(
          err instanceof ApiRequestError && err.status === 410
            ? { status: "expired" }
            : { status: "error", message: err instanceof Error ? err.message : "The prompt couldn't be loaded." },
        ),
    );
    return () => {
      live = false;
    };
  }, [runId, call.id]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent aria-describedby={undefined} className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {call.purpose ?? call.stage} · {call.model}
          </DialogTitle>
        </DialogHeader>
        {state.status === "loading" && <p className="text-muted-foreground" role="status">Loading the prompt…</p>}
        {state.status === "expired" && <p className="text-muted-foreground">Prompt expired (kept 14 days).</p>}
        {state.status === "error" && <p role="alert">{state.message}</p>}
        {state.status === "ready" && (
          <div className="flex min-w-0 flex-col gap-4">
            {state.exchange.truncated && <p className="text-sm text-muted-foreground">Earlier messages were left out: this request was over 4 MB.</p>}
            <Block label="System prompt" text={state.exchange.system || "(none)"} />
            {state.exchange.messages.map((m, i) => (
              <Block key={i} label={m.role === "user" ? `Message ${i + 1} (to the model)` : `Message ${i + 1} (model's earlier answer)`} text={contentText(m.content)} />
            ))}
            {state.exchange.response !== null && <Block label="Response" text={state.exchange.response} />}
            {state.exchange.error !== null && <Block label="Error" text={state.exchange.error} />}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
