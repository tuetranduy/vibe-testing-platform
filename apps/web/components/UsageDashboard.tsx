"use client";

import type { UsageReport } from "@platform/contracts";
import { useEffect, useRef, useState } from "react";
import { getUsage } from "../lib/api";
import { isAdminUser, useMe } from "../lib/me";
import { Disclosure } from "./Disclosure";
import { LIFECYCLE_LABEL } from "./format";
import { Icon } from "./Icon";
import { hostOf, runTitle } from "./report-format";

type State = { status: "loading" } | { status: "ready"; usage: UsageReport } | { status: "error"; message: string };

const RANGES = [7, 30, 90] as const;
type Range = (typeof RANGES)[number];

const DAY_MS = 86_400_000;
const dayOf = (d: Date) => d.toISOString().slice(0, 10);

/** Money: cents up to $100, whole dollars above; amounts under 10 cents keep more digits so they don't read as zero. */
export function formatUsd(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 0.1) return `$${usd.toFixed(3)}`;
  return usd < 100 ? `$${usd.toFixed(2)}` : `$${Math.round(usd).toLocaleString("en-US")}`;
}

const compact = (n: number) =>
  n < 1000 ? String(n) : n < 1_000_000 ? `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K` : `${(n / 1_000_000).toFixed(1)}M`;

const shortDay = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/**
 * Usage (V1.1 F7): what the model calls of recent test runs cost, by day, model, stage and run. Members see
 * their own runs; administrators everyone's (or their own). Costs are estimates from list prices.
 */
export function UsageDashboard({ today = () => new Date() }: { today?: () => Date }) {
  const [range, setRange] = useState<Range>(30);
  const [owner, setOwner] = useState<"all" | "me">("all");
  const [state, setState] = useState<State>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const me = useMe();
  const admin = isAdminUser(me);

  useEffect(() => {
    let live = true;
    const to = dayOf(today());
    const from = dayOf(new Date(new Date(`${to}T00:00:00Z`).getTime() - (range - 1) * DAY_MS));
    setState({ status: "loading" });
    getUsage({ from, to, ...(owner === "me" ? { owner: "me" } : {}) }).then(
      (usage) => live && setState({ status: "ready", usage }),
      (err: unknown) => live && setState({ status: "error", message: err instanceof Error ? err.message : "Something went wrong." }),
    );
    return () => {
      live = false;
    };
    // `today` is a test seam and not a dependency: a new function each render would refetch forever.
  }, [range, owner, attempt]);

  return (
    <div className="stack-lg">
      <div className="page-head">
        <div className="title-block">
          <h1 className="page-title">Usage</h1>
          <p className="page-lede">
            What the AI model calls of {me && !admin ? "your" : "the"} test runs cost. Estimates from each model&apos;s list price; reruns
            of a saved test make no model calls.
          </p>
        </div>
      </div>
      <div className="usage-filters" role="group" aria-label="Filters">
        <div className="filter-chips" role="group" aria-label="Period">
          {RANGES.map((r) => (
            <button key={r} type="button" className="chip" aria-pressed={range === r} onClick={() => setRange(r)}>
              Last {r} days
            </button>
          ))}
        </div>
        {admin && (
          <div className="filter-chips" role="group" aria-label="Whose runs">
            {(
              [
                ["all", "Everyone's runs"],
                ["me", "My runs"],
              ] as const
            ).map(([id, label]) => (
              <button key={id} type="button" className="chip" aria-pressed={owner === id} onClick={() => setOwner(id)}>
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {state.status === "loading" && (
        <p className="muted" role="status">
          Loading usage…
        </p>
      )}
      {state.status === "error" && (
        <div role="alert" className="banner banner-error">
          <Icon name="warning" />
          <div>
            <p className="banner-title">Usage couldn&apos;t be loaded</p>
            <p>{state.message}</p>
            <div className="actions">
              <button type="button" className="button button-secondary" onClick={() => setAttempt((n) => n + 1)}>
                Try again
              </button>
            </div>
          </div>
        </div>
      )}
      {state.status === "ready" && <UsageBody usage={state.usage} />}
    </div>
  );
}

function UsageBody({ usage }: { usage: UsageReport }) {
  const t = usage.totals;
  return (
    <>
      <div className="stats usage-stats">
        <div className="stat" role="group" aria-label="Estimated cost">
          <p className="stat-label">Estimated cost</p>
          <p className="stat-value usage-hero">{formatUsd(t.estimatedCostUsd)}</p>
          <p className="stat-sub">
            {shortDay(usage.from)} – {shortDay(usage.to)} (UTC)
          </p>
        </div>
        <div className="stat" role="group" aria-label="Model calls">
          <p className="stat-label">Model calls</p>
          <p className="stat-value">{t.llmCalls.toLocaleString("en-US")}</p>
          <p className="stat-sub">in {t.runs === 1 ? "1 run" : `${t.runs} runs`}</p>
        </div>
        <div className="stat" role="group" aria-label="Tokens">
          <p className="stat-label">Tokens</p>
          <p className="stat-value">{compact(t.inputTokens + t.outputTokens)}</p>
          <p className="stat-sub">
            {compact(t.inputTokens)} in · {compact(t.outputTokens)} out
          </p>
        </div>
        <div className="stat" role="group" aria-label="Average per run">
          <p className="stat-label">Average per run</p>
          <p className="stat-value">{t.runs === 0 ? "—" : formatUsd(t.estimatedCostUsd / t.runs)}</p>
          <p className="stat-sub">runs with model calls</p>
        </div>
      </div>

      <section className="card stack" aria-labelledby="usage-daily-title">
        <div className="section-head">
          <h2 id="usage-daily-title" className="card-title">
            Estimated cost per day
          </h2>
        </div>
        {t.llmCalls === 0 ? <p className="muted">No model calls in this period.</p> : <DailyCostChart days={usage.byDay} />}
      </section>
      {t.llmCalls > 0 && (
        <Disclosure title="Show as a table" hint="Every day of the period.">
          <div className="data-table-wrap">
            <table className="data-table">
              <caption className="visually-hidden">Estimated cost per day</caption>
              <thead>
                <tr>
                  <th scope="col">Day (UTC)</th>
                  <th scope="col" className="num">
                    Model calls
                  </th>
                  <th scope="col" className="num">
                    Estimated cost
                  </th>
                </tr>
              </thead>
              <tbody>
                {usage.byDay.map((d) => (
                  <tr key={d.day}>
                    <td>{d.day}</td>
                    <td className="num">{d.llmCalls}</td>
                    <td className="num">{formatUsd(d.estimatedCostUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Disclosure>
      )}

      {t.llmCalls > 0 && (
        <div className="usage-grid">
          <section className="card table-card" aria-labelledby="usage-models-title">
            <div className="table-toolbar">
              <h2 id="usage-models-title" className="card-title">
                By model
              </h2>
            </div>
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Model</th>
                    <th scope="col" className="num">
                      Calls
                    </th>
                    <th scope="col" className="num">
                      Tokens
                    </th>
                    <th scope="col" className="num">
                      Cost
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {usage.byModel.map((m) => (
                    <tr key={`${m.provider}/${m.model}`}>
                      <td title={m.model}>{m.label}</td>
                      <td className="num">{m.llmCalls}</td>
                      <td className="num">{compact(m.inputTokens + m.outputTokens)}</td>
                      <td className="num">{formatUsd(m.estimatedCostUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section className="card table-card" aria-labelledby="usage-stages-title">
            <div className="table-toolbar">
              <h2 id="usage-stages-title" className="card-title">
                By stage
              </h2>
            </div>
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Stage</th>
                    <th scope="col" className="num">
                      Calls
                    </th>
                    <th scope="col" className="num">
                      Cost
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {usage.byStage.map((s) => (
                    <tr key={s.stage}>
                      <td>{LIFECYCLE_LABEL[s.stage]}</td>
                      <td className="num">{s.llmCalls}</td>
                      <td className="num">{formatUsd(s.estimatedCostUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}

      {usage.topRuns.length > 0 && (
        <section className="card table-card" aria-labelledby="usage-runs-title">
          <div className="table-toolbar">
            <h2 id="usage-runs-title" className="card-title">
              Most expensive runs
            </h2>
          </div>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Run</th>
                  <th scope="col">Website</th>
                  {usage.scope === "all" && <th scope="col">By</th>}
                  <th scope="col" className="num">
                    Calls
                  </th>
                  <th scope="col" className="num">
                    Cost
                  </th>
                </tr>
              </thead>
              <tbody>
                {usage.topRuns.map((r) => (
                  <tr key={r.runId}>
                    <td>
                      <a href={`/runs/${encodeURIComponent(r.runId)}`}>{runTitle(r)}</a>
                    </td>
                    <td className="mono">{hostOf(r.targetUrl)}</td>
                    {usage.scope === "all" && <td>{r.owner?.name ?? "—"}</td>}
                    <td className="num">{r.llmCalls}</td>
                    <td className="num">{formatUsd(r.estimatedCostUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

/** Clean y-axis ticks (0, 1, 2 or 5 × 10^n steps) covering `max`. */
export function niceTicks(max: number, target = 4): number[] {
  if (max <= 0) return [0];
  const raw = max / target;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw)!;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.999; v += step) ticks.push(Number(v.toPrecision(12)));
  return ticks;
}

const H = 220;
const PAD = { top: 12, right: 8, bottom: 28, left: 56 };
const R = 4;

/**
 * One series, one hue (the chart token): columns from a single baseline, ≤ 24px wide with a 2px gap, 4px
 * rounded tops, a hairline grid on clean ticks, sparse x labels, and a tooltip per day on hover (the table
 * view beside it carries every value, for keyboard and screen-reader users).
 */
function DailyCostChart({ days }: { days: UsageReport["byDay"] }) {
  const [hover, setHover] = useState<number | null>(null);
  // Drawn at the container's own pixel width, so text and corners keep their size on every screen.
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(720);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => entry && setW(Math.max(280, Math.round(entry.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const ticks = niceTicks(Math.max(...days.map((d) => d.estimatedCostUsd)));
  const top = ticks.at(-1)! || 1;
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const slot = plotW / days.length;
  const barW = Math.max(1, Math.min(24, slot - 2));
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
  const labelEvery = Math.ceil(days.length / Math.max(2, Math.floor(plotW / 90)));
  const total = days.reduce((n, d) => n + d.estimatedCostUsd, 0);
  const peak = days.reduce((a, b) => (b.estimatedCostUsd > a.estimatedCostUsd ? b : a));
  const shown = hover === null ? null : days[hover]!;
  const summary = `Estimated cost per day, ${days.length} days, ${formatUsd(total)} in total; highest on ${shortDay(peak.day)} (${formatUsd(peak.estimatedCostUsd)}).`;

  return (
    <div className="usage-chart" ref={box}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary} onMouseLeave={() => setHover(null)}>
        <defs>
          <linearGradient id="chart-bar-gradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" className="chart-stop-top" />
            <stop offset="1" className="chart-stop-bottom" />
          </linearGradient>
        </defs>
        {ticks.map((v) => (
          <g key={v}>
            <line className="chart-grid" x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} />
            <text className="chart-axis" x={PAD.left - 8} y={y(v)} dy="0.32em" textAnchor="end">
              {formatUsd(v)}
            </text>
          </g>
        ))}
        {days.map((d, i) => {
          const x = PAD.left + i * slot + (slot - barW) / 2;
          const h = (d.estimatedCostUsd / top) * plotH;
          const r = Math.min(R, h, barW / 2);
          const base = PAD.top + plotH;
          return (
            <g key={d.day}>
              {h > 0 && (
                <path
                  className="chart-bar"
                  d={`M${x},${base} V${base - h + r} Q${x},${base - h} ${x + r},${base - h} H${x + barW - r} Q${x + barW},${base - h} ${x + barW},${base - h + r} V${base} Z`}
                  opacity={hover === null || hover === i ? 1 : 0.45}
                />
              )}
              {i % labelEvery === 0 && (
                <text className="chart-axis" x={PAD.left + i * slot + slot / 2} y={H - 8} textAnchor="middle">
                  {shortDay(d.day)}
                </text>
              )}
              {/* The hit target is the whole column, taller than the mark. */}
              <rect x={PAD.left + i * slot} y={PAD.top} width={slot} height={plotH} fill="transparent" onMouseEnter={() => setHover(i)} />
            </g>
          );
        })}
      </svg>
      {shown && (
        <div className="chart-tooltip" role="status" style={{ left: Math.min(W - 70, Math.max(70, PAD.left + (hover! + 0.5) * slot)) }}>
          <strong>{shortDay(shown.day)}</strong>
          <span>{formatUsd(shown.estimatedCostUsd)}</span>
          <span className="muted">{shown.llmCalls === 1 ? "1 call" : `${shown.llmCalls} calls`}</span>
        </div>
      )}
    </div>
  );
}
