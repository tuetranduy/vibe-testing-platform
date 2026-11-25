"use client";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import {
  RunLifecycleSchema,
  RunLogLevelSchema,
  RunLogSourceSchema,
  isTerminalLifecycle,
  type LlmCallView,
  type RunLifecycle,
  type RunLlmCalls,
  type RunLogLevel,
  type RunLogLine,
  type RunLogSource,
  type TestRunSummary,
} from "@platform/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getRun, getRunLlmCalls, getRunLogs, type RunLogFilters } from "../../lib/api";
import { useMe } from "../../lib/me";
import { Disclosure } from "../Disclosure";
import { ERROR_CATEGORY_LABEL } from "../format";
import { LlmCallsTable, LlmExchangeDialog } from "./LlmCalls";
import { LogTimeline, SOURCE_LABEL, clock, lineAnchor, mergeTimeline } from "./LogTimeline";

const POLL_MS = 3000;
const PAGE = 500;
/** Lines kept in the view; older ones are dropped from the top while a long run streams. */
const MAX_IN_VIEW = 20_000;

type Load = { status: "loading" } | { status: "ready" } | { status: "error"; message: string };

const errorText = (line: RunLogLine): string | null => {
  const err = line.fields.err;
  if (err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string") return (err as { message: string }).message;
  return typeof err === "string" ? err : null;
};

/**
 * Admin run logs (2026-11-25): one run's lines from every source and its model calls with their prompts. Renders
 * nothing for anyone but an administrator. `pollMs` is a test seam.
 */
export function RunLogs({ runId, summary, pollMs = POLL_MS }: { runId: string; summary: TestRunSummary; pollMs?: number }) {
  const me = useMe();
  const isAdmin = me?.role === "admin";
  const terminal = isTerminalLifecycle(summary.lifecycle);

  const [sources, setSources] = useState<RunLogSource[]>([]);
  const [minLevel, setMinLevel] = useState<RunLogLevel | "">("");
  const [stage, setStage] = useState<RunLifecycle | "">("");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const filters = useMemo<RunLogFilters>(
    () => ({
      ...(sources.length ? { source: sources } : {}),
      ...(minLevel ? { minLevel } : {}),
      ...(stage ? { stage } : {}),
      ...(query ? { q: query } : {}),
    }),
    [sources, minLevel, stage, query],
  );
  const filtered = Boolean(sources.length || minLevel || query);

  const [lines, setLines] = useState<RunLogLine[]>([]);
  const [calls, setCalls] = useState<RunLlmCalls | null>(null);
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const cursor = useRef<string | null>(null);
  const generation = useRef(0);
  const [tab, setTab] = useState<"timeline" | "calls">("timeline");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [openCall, setOpenCall] = useState<LlmCallView | null>(null);

  const append = (more: RunLogLine[]) =>
    setLines((prev) => {
      const seen = new Set(prev.map((l) => l.id));
      const next = [...prev, ...more.filter((l) => !seen.has(l.id))];
      return next.length > MAX_IN_VIEW ? next.slice(next.length - MAX_IN_VIEW) : next;
    });

  // First page (again whenever the filters change).
  useEffect(() => {
    if (!isAdmin) return;
    const gen = ++generation.current;
    setLoad({ status: "loading" });
    setLines([]);
    cursor.current = null;
    Promise.all([getRunLogs(runId, { ...filters, limit: PAGE }), getRunLlmCalls(runId)]).then(
      ([page, llm]) => {
        if (gen !== generation.current) return;
        setLines(page.lines);
        setNextCursor(page.nextCursor);
        cursor.current = page.lastCursor;
        setCalls(llm);
        setLoad({ status: "ready" });
      },
      (err: unknown) => gen === generation.current && setLoad({ status: "error", message: err instanceof Error ? err.message : "The logs couldn't be loaded." }),
    );
  }, [isAdmin, runId, filters]);

  // Live: new lines and calls every few seconds while the run is not over, then once more when it ends.
  const poll = useCallback(async () => {
    const gen = generation.current;
    try {
      const [page, llm] = await Promise.all([
        getRunLogs(runId, { ...filters, limit: PAGE, ...(cursor.current ? { after: cursor.current } : {}) }),
        getRunLlmCalls(runId),
      ]);
      if (gen !== generation.current) return;
      append(page.lines);
      if (page.lastCursor) cursor.current = page.lastCursor;
      setCalls(llm);
    } catch {
      // the next tick tries again
    }
  }, [runId, filters]);

  const wasTerminal = useRef(terminal);
  useEffect(() => {
    if (!isAdmin || load.status !== "ready") return;
    if (terminal) {
      if (!wasTerminal.current) void poll();
      wasTerminal.current = true;
      return;
    }
    wasTerminal.current = false;
    const timer = setInterval(() => void poll(), pollMs);
    return () => clearInterval(timer);
  }, [isAdmin, load.status, terminal, poll, pollMs]);

  const loadMore = async () => {
    if (!nextCursor) return;
    const gen = generation.current;
    const page = await getRunLogs(runId, { ...filters, limit: PAGE, after: nextCursor });
    if (gen !== generation.current) return;
    append(page.lines);
    setNextCursor(page.nextCursor);
    if (page.lastCursor) cursor.current = page.lastCursor;
  };

  const download = async () => {
    const all: RunLogLine[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await getRunLogs(runId, { limit: 1000, ...(after ? { after } : {}) });
      all.push(...page.lines);
      if (!page.nextCursor) break;
      after = page.nextCursor;
    }
    const blob = new Blob([all.map((l) => JSON.stringify(l)).join("\n") + "\n"], { type: "application/x-ndjson" });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), { href: url, download: `run-${runId}-logs.jsonl` });
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!isAdmin) return null;

  const callsInView = (calls?.calls ?? []).filter((c) => !filtered && (!stage || c.stage === stage));
  const items = mergeTimeline(lines, callsInView);
  const failed = summary.lifecycle === "ERRORED" || summary.verdict === "FAILED";
  const failures = lines.filter((l) => l.level === "error" || l.level === "fatal").slice(-5);

  const jump = (id: string) => {
    setTab("timeline");
    setExpanded((prev) => new Set(prev).add(id));
    requestAnimationFrame(() => document.getElementById(lineAnchor(id))?.scrollIntoView({ block: "center" }));
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {failed && (
        <section aria-label="Why it failed" className="banner banner-error flex-col items-stretch">
          <p className="banner-title">
            Why it failed: {summary.errorCategory ? ERROR_CATEGORY_LABEL[summary.errorCategory] : "the checks did not pass"}
          </p>
          {failures.length === 0 ? (
            <p className="text-sm">No error lines were logged{load.status === "ready" ? "" : " yet"}.</p>
          ) : (
            <ul className="flex flex-col gap-1.5 font-mono text-[0.8125rem]">
              {failures.map((l) => (
                <li key={l.id} className="flex flex-wrap items-baseline gap-x-3">
                  <span className="tabular-nums">{clock(l.time)}</span>
                  <span>{SOURCE_LABEL[l.source]}</span>
                  <span className="min-w-0 flex-1 break-words">
                    {l.message}
                    {errorText(l) ? `: ${errorText(l)}` : ""}
                  </span>
                  <Button variant="ghost" size="sm" type="button" className="h-6 px-2" onClick={() => jump(l.id)}>
                    Jump to line <span className="sr-only">{l.message}</span>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <div role="tablist" aria-label="Run logs" className="flex flex-wrap items-center gap-2">
        <Button role="tab" type="button" variant={tab === "timeline" ? "default" : "outline"} aria-selected={tab === "timeline"} onClick={() => setTab("timeline")}>
          Timeline
        </Button>
        <Button role="tab" type="button" variant={tab === "calls" ? "default" : "outline"} aria-selected={tab === "calls"} onClick={() => setTab("calls")}>
          Model calls ({calls?.totals.calls ?? 0})
        </Button>
        <span className="ml-auto flex items-center gap-2 text-sm text-muted-foreground">
          {!terminal && <span role="status">Live</span>}
          <Button variant="outline" size="sm" type="button" onClick={() => void download().catch(() => {})}>
            Download
          </Button>
        </span>
      </div>

      {tab === "timeline" ? (
        <>
          <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <legend className="sr-only">Sources</legend>
            {RunLogSourceSchema.options.map((s) => (
              <label key={s} className="flex cursor-pointer items-center gap-2 text-sm">
                <Checkbox
                  aria-label={SOURCE_LABEL[s]}
                  checked={sources.includes(s)}
                  onCheckedChange={() => setSources((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]))}
                />
                {SOURCE_LABEL[s]}
              </label>
            ))}
          </fieldset>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-sm">
              Minimum level
              <NativeSelect value={minLevel} onChange={(e) => setMinLevel(e.target.value as RunLogLevel | "")}>
                <option value="">Everything</option>
                {RunLogLevelSchema.options.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Stage
              <NativeSelect value={stage} onChange={(e) => setStage(e.target.value as RunLifecycle | "")}>
                <option value="">All stages</option>
                {RunLifecycleSchema.options.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <form
              className="flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                setQuery(q.trim());
              }}
            >
              <label className="flex flex-col gap-1 text-sm">
                Search messages
                <Input value={q} maxLength={200} onChange={(e) => setQ(e.target.value)} />
              </label>
              <Button type="submit" variant="outline">
                Search
              </Button>
            </form>
          </div>

          {load.status === "loading" && (
            <p className="text-muted-foreground" role="status">
              Loading logs…
            </p>
          )}
          {load.status === "error" && <p role="alert">{load.message}</p>}
          {load.status === "ready" &&
            (items.length === 0 ? (
              <p className="text-muted-foreground">{filtered || stage ? "No lines match these filters." : "No logs were recorded for this run."}</p>
            ) : (
              <LogTimeline
                items={items}
                expanded={expanded}
                onToggle={(id) =>
                  setExpanded((prev) => {
                    const next = new Set(prev);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                  })
                }
                onOpenCall={setOpenCall}
              />
            ))}
          {nextCursor && (
            <Button variant="outline" type="button" onClick={() => void loadMore().catch(() => {})}>
              Load more
            </Button>
          )}
        </>
      ) : calls ? (
        <LlmCallsTable data={calls} onOpen={setOpenCall} />
      ) : (
        <p className="text-muted-foreground" role="status">
          Loading model calls…
        </p>
      )}

      {openCall && <LlmExchangeDialog runId={runId} call={openCall} onClose={() => setOpenCall(null)} />}
    </div>
  );
}

/** The run page's Logs section: administrators only (members never see that it exists). */
export function RunLogsSection({ runId, summary }: { runId: string; summary: TestRunSummary }) {
  const me = useMe();
  if (me?.role !== "admin") return null;
  return (
    <Disclosure title="Logs" hint="Every log line, model call and infrastructure event of this run (administrators).">
      <RunLogs runId={runId} summary={summary} />
    </Disclosure>
  );
}

/** `/runs/<id>/logs`: the same view on its own page. Anyone but an administrator gets "not found". */
export function RunLogsPage({ runId }: { runId: string }) {
  const me = useMe();
  const [summary, setSummary] = useState<TestRunSummary | null>(null);
  const [missing, setMissing] = useState(false);
  const isAdmin = me?.role === "admin";
  useEffect(() => {
    if (!isAdmin) return;
    let live = true;
    const load = () =>
      getRun(runId).then(
        (s) => live && setSummary(s),
        () => live && setMissing(true),
      );
    void load();
    // The view polls lines itself; the summary only tells it when the run has ended.
    const timer = setInterval(() => void load(), 10_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [isAdmin, runId]);

  if (missing || (me && !isAdmin)) {
    return (
      <section className="flex min-w-0 flex-col gap-3">
        <h1>Page not found</h1>
        <p className="text-muted-foreground">Check the link.</p>
      </section>
    );
  }
  if (!summary) {
    return (
      <p className="text-muted-foreground" role="status">
        Loading run…
      </p>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <h1>
        Logs · <a href={`/runs/${encodeURIComponent(runId)}`}>{runId}</a>
      </h1>
      <RunLogs runId={runId} summary={summary} />
    </div>
  );
}
