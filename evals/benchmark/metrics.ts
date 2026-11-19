import { PASSED_ON_SHALLOW, qualifiedPassLabel, type RunVerdict, type TestReport } from "@platform/contracts";

/**
 * The quality benchmark's numbers (2026-11-19): how many criteria the platform decides, how many seeded bugs it catches
 * (and how many it passes: the worst error a testing platform can make), false failures on healthy sites, passes that
 * rest on one broad check, how often the rerun confirms a decision, and what a run costs. Pure: runs in, summary out.
 */

/** One benchmark case: a requirement on a site, and the verdict a correct platform gives (ANY: not known). */
export interface BenchmarkCase {
  id: string;
  site: string;
  targetUrl: string;
  requirement: string;
  expect: "PASSED" | "FAILED" | "BLOCKED" | "INCONCLUSIVE" | "ANY";
  /** The demo shop's seeded defect the case runs against: the run must FAIL. */
  bug?: string;
}

/** One run of a case; `report` is null when the run errored before it had one, or never finished. */
export interface CaseRun {
  caseId: string;
  repeat: number;
  runId: string | null;
  lifecycle: string;
  report: TestReport | null;
  error?: string;
}

export interface BenchmarkSummary {
  runs: number;
  /** Runs that ended ERRORED, or without a report. */
  errored: number;
  verdicts: Partial<Record<RunVerdict, number>>;
  criteria: { total: number; pass: number; fail: number; blocked: number; inconclusive: number };
  /** (PASS + FAIL) / all criteria. */
  decidedRate: number;
  /** Runs of seeded-bug cases, and how many of them FAILED (caught) or PASSED (missed). */
  bugRuns: number;
  bugsCaught: number;
  falsePasses: number;
  /** Runs of cases expected to PASS, and how many FAILED. */
  healthyRuns: number;
  falseFails: number;
  /** Runs whose verdict is the expected one, of those with an expectation. */
  expectationMet: number;
  expectationRuns: number;
  shallowPasses: number;
  /** Rerun-confirmed criteria / decided criteria. */
  rerunConfirmedRate: number;
  /** BLOCKED and INCONCLUSIVE criteria by reason. */
  undecidedReasons: Record<string, number>;
  costUsd: number;
  medianDurationS: number | null;
  perCase: { id: string; site: string; expect: BenchmarkCase["expect"]; verdicts: (RunVerdict | null)[]; stable: boolean }[];
}

const ratio = (n: number, d: number) => (d === 0 ? 0 : n / d);

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function summarize(cases: readonly BenchmarkCase[], runs: readonly CaseRun[]): BenchmarkSummary {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const verdicts: Partial<Record<RunVerdict, number>> = {};
  const criteria = { total: 0, pass: 0, fail: 0, blocked: 0, inconclusive: 0 };
  const undecidedReasons: Record<string, number> = {};
  let errored = 0, bugRuns = 0, bugsCaught = 0, falsePasses = 0, healthyRuns = 0, falseFails = 0;
  let expectationMet = 0, expectationRuns = 0, shallowPasses = 0, confirmed = 0, costUsd = 0;
  const durations: number[] = [];

  for (const run of runs) {
    const c = byId.get(run.caseId);
    const r = run.report;
    if (!r || r.lifecycle === "ERRORED" || run.lifecycle === "ERRORED") errored++;
    // Every attempted run counts in the denominators, a run with no report too: it met nothing (review finding).
    const verdict = r?.verdict ?? null;
    if (c?.bug) {
      bugRuns++;
      if (verdict === "FAILED") bugsCaught++;
      if (verdict === "PASSED") falsePasses++;
    }
    if (c?.expect === "PASSED") {
      healthyRuns++;
      if (verdict === "FAILED") falseFails++;
    }
    if (c && c.expect !== "ANY") {
      expectationRuns++;
      if (verdict === c.expect) expectationMet++;
    }
    if (!r) continue;
    if (verdict) verdicts[verdict] = (verdicts[verdict] ?? 0) + 1;
    for (const res of r.criteria) {
      criteria.total++;
      if (res.status === "PASS") criteria.pass++;
      else if (res.status === "FAIL") criteria.fail++;
      else {
        if (res.status === "BLOCKED") criteria.blocked++;
        else criteria.inconclusive++;
        const reason = res.reason ?? "NONE";
        undecidedReasons[reason] = (undecidedReasons[reason] ?? 0) + 1;
      }
      if (res.verdictSource === "PLAYWRIGHT_RERUN") confirmed++;
    }
    if (qualifiedPassLabel(r) === PASSED_ON_SHALLOW) shallowPasses++;
    costUsd += r.usage?.estimatedCostUsd ?? 0;
    if (typeof r.durationMs === "number") durations.push(r.durationMs / 1000);
  }

  const perCase = cases
    .map((c) => {
      const verdictsOf = runs.filter((r) => r.caseId === c.id).sort((a, b) => a.repeat - b.repeat).map((r) => r.report?.verdict ?? null);
      return { id: c.id, site: c.site, expect: c.expect, verdicts: verdictsOf, stable: new Set(verdictsOf).size <= 1 };
    })
    .filter((c) => c.verdicts.length > 0);

  const decided = criteria.pass + criteria.fail;
  return {
    runs: runs.length,
    errored,
    verdicts,
    criteria,
    decidedRate: ratio(decided, criteria.total),
    bugRuns,
    bugsCaught,
    falsePasses,
    healthyRuns,
    falseFails,
    expectationMet,
    expectationRuns,
    shallowPasses,
    rerunConfirmedRate: ratio(confirmed, decided),
    undecidedReasons,
    costUsd: Math.round(costUsd * 10_000) / 10_000,
    medianDurationS: median(durations),
    perCase,
  };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const signed = (n: number, unit = "") => `${n > 0 ? "+" : ""}${unit === "%" ? Math.round(n * 100) : Math.round(n * 1000) / 1000}${unit}`;

/** The headline rows: [metric, shown value, number compared (or null), unit of the change]. */
function rows(s: BenchmarkSummary): [string, string, number | null, string][] {
  return [
    ["Runs", String(s.runs), s.runs, ""],
    ["Errored runs", String(s.errored), s.errored, ""],
    ["Criteria decided (PASS + FAIL)", `${s.criteria.pass + s.criteria.fail} / ${s.criteria.total} (${pct(s.decidedRate)})`, s.decidedRate, "%"],
    ["Bugs caught", `${s.bugsCaught} / ${s.bugRuns}`, s.bugsCaught, ""],
    ["False passes (bug missed)", String(s.falsePasses), s.falsePasses, ""],
    ["False fails (healthy case FAILED)", `${s.falseFails} / ${s.healthyRuns}`, s.falseFails, ""],
    ["Expected verdict", `${s.expectationMet} / ${s.expectationRuns}`, s.expectationMet, ""],
    ["Passes on one broad check", String(s.shallowPasses), s.shallowPasses, ""],
    ["Decided criteria the rerun confirmed", pct(s.rerunConfirmedRate), s.rerunConfirmedRate, "%"],
    ["Model cost", `$${s.costUsd.toFixed(2)}`, s.costUsd, ""],
    ["Median run time", s.medianDurationS === null ? "—" : `${Math.round(s.medianDurationS)} s`, s.medianDurationS, ""],
  ];
}

/** The summary as Markdown; with `previous`, each headline row also shows the earlier value and the change. */
export function renderMarkdown(s: BenchmarkSummary, previous?: BenchmarkSummary): string {
  const now = rows(s);
  const before = previous ? rows(previous) : null;
  const head = before ? ["| Metric | Value | Before | Change |", "|---|---|---|---|"] : ["| Metric | Value |", "|---|---|"];
  const headline = now.map(([name, shown, n, unit], i) => {
    if (!before) return `| ${name} | ${shown} |`;
    const [, was, m] = before[i]!;
    const change = n === null || m === null ? "—" : n === m ? "0" : signed(n - m, unit);
    return `| ${name} | ${shown} | ${was} | ${change} |`;
  });
  const verdicts = Object.entries(s.verdicts).map(([v, n]) => `${v} ${n}`).join(" · ") || "—";
  const reasons = Object.entries(s.undecidedReasons).sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ${n}`).join(" · ") || "—";
  const cases = s.perCase.map((c) => {
    const shown = c.verdicts.map((v) => v ?? "ERRORED").join(", ");
    const met = c.expect === "ANY" ? "—" : c.verdicts.every((v) => v === c.expect) ? "yes" : "no";
    return `| ${c.id} | ${c.site} | ${c.expect} | ${shown} | ${met}${c.stable ? "" : " (unstable)"} |`;
  });
  return [
    ...head,
    ...headline,
    "",
    `Run verdicts: ${verdicts}`,
    "",
    `Undecided criteria by reason: ${reasons}`,
    "",
    "| Case | Site | Expected | Verdicts | Met |",
    "|---|---|---|---|---|",
    ...cases,
    "",
  ].join("\n");
}
