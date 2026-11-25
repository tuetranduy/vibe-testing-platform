"use client";

import { Button } from "@/components/ui/button";
import type { LlmCallView, RunLogLine, RunLogSource } from "@platform/contracts";
import { useState } from "react";

export const SOURCE_LABEL: Record<RunLogSource, string> = {
  worker: "Worker",
  api: "API",
  runner: "Runner",
  browser_use: "Browser Use",
  infra: "Infrastructure",
  web_app: "Web app",
  target_site: "Tested site",
};

const LEVEL_CLASS: Record<string, string> = {
  trace: "text-muted-foreground",
  debug: "text-muted-foreground",
  info: "text-foreground",
  warn: "text-amber-700 dark:text-amber-400",
  error: "text-red-700 dark:text-red-400",
  fatal: "text-red-700 dark:text-red-400 font-semibold",
};

export type TimelineItem = { kind: "line"; line: RunLogLine } | { kind: "call"; call: LlmCallView };

const timeOf = (item: TimelineItem) => (item.kind === "line" ? item.line.time : item.call.time);
/** Clock time with milliseconds, in the viewer's zone. */
export const clock = (iso: string) => {
  const d = new Date(iso);
  return `${d.toLocaleTimeString("en-GB", { hour12: false })}.${String(d.getMilliseconds()).padStart(3, "0")}`;
};

export function mergeTimeline(lines: RunLogLine[], calls: LlmCallView[]): TimelineItem[] {
  const items: TimelineItem[] = [...lines.map((line) => ({ kind: "line" as const, line })), ...calls.map((call) => ({ kind: "call" as const, call }))];
  return items.sort((a, b) => timeOf(a).localeCompare(timeOf(b)));
}

export const lineAnchor = (id: string) => `run-log-${id}`;

export function callSummary(call: LlmCallView): string {
  return `${call.purpose ?? call.stage} · ${call.model} · ${call.inputTokens.toLocaleString("en-US")}→${call.outputTokens.toLocaleString("en-US")} tok · ${(call.latencyMs / 1000).toFixed(1)} s`;
}

export function LogTimeline({
  items,
  expanded,
  onToggle,
  onOpenCall,
}: {
  items: TimelineItem[];
  expanded: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onOpenCall: (call: LlmCallView) => void;
}) {
  return (
    <ol aria-label="Timeline" className="m-0 flex min-w-0 list-none flex-col p-0 divide-y divide-border font-mono text-[0.8125rem]">
      {items.map((item) =>
        item.kind === "call" ? (
          <li key={item.call.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-1.5">
            <span className="text-muted-foreground tabular-nums">{clock(item.call.time)}</span>
            <span className="w-24 shrink-0 text-muted-foreground">Model call</span>
            <span className={item.call.status === "SUCCESS" ? "" : LEVEL_CLASS.warn}>{callSummary(item.call)}</span>
            {item.call.status !== "SUCCESS" && <span className={LEVEL_CLASS.warn}>{item.call.status}</span>}
            <Button variant="ghost" size="sm" type="button" className="ml-auto h-6 px-2" onClick={() => onOpenCall(item.call)}>
              View prompt
            </Button>
          </li>
        ) : (
          <TimelineLine key={item.line.id} line={item.line} open={expanded.has(item.line.id)} onToggle={() => onToggle(item.line.id)} />
        ),
      )}
    </ol>
  );
}

function TimelineLine({ line, open, onToggle }: { line: RunLogLine; open: boolean; onToggle: () => void }) {
  const hasFields = Object.keys(line.fields).length > 0;
  return (
    <li id={lineAnchor(line.id)} className="scroll-mt-24 py-1.5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-muted-foreground tabular-nums">{clock(line.time)}</span>
        <span className="w-24 shrink-0 text-muted-foreground">{SOURCE_LABEL[line.source]}</span>
        <span className={`w-10 shrink-0 uppercase ${LEVEL_CLASS[line.level] ?? ""}`}>{line.level}</span>
        <span className={`min-w-0 flex-1 break-words ${LEVEL_CLASS[line.level] ?? ""}`}>{line.message || "(no message)"}</span>
        {hasFields && (
          <Button variant="ghost" size="sm" type="button" className="h-6 px-2" aria-expanded={open} onClick={onToggle}>
            {open ? "Hide details" : "Details"}
          </Button>
        )}
      </div>
      {open && hasFields && (
        <pre className="mt-1.5 max-h-96 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap break-words">
          {JSON.stringify(line.fields, null, 2)}
        </pre>
      )}
    </li>
  );
}
