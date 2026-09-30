import type {
  ComparisonCounts,
  CriterionChange,
  CriterionComparison,
  CriterionStatus,
  RunChange,
  RunVerdict,
  TestReport,
} from "@platform/contracts";

/** What a comparison needs of one run (V1.2 F2). */
export interface ComparableRun {
  verdict: RunVerdict | null;
  criteria: { id: string; description: string; critical: boolean; status: CriterionStatus }[];
  durationMs: number | null;
  costUsd: number | null;
}

export interface ResultComparison {
  verdict: { before: RunVerdict | null; after: RunVerdict | null };
  criteria: CriterionComparison[];
  counts: ComparisonCounts;
  durationMs: { before: number | null; after: number | null };
  costUsd: { before: number | null; after: number | null };
}

/** A report's criteria with their wording (the confirmed statement; the id when it is missing). */
export function comparableFromReport(report: TestReport): ComparableRun {
  const statements = new Map((report.requirement?.criteria ?? []).map((c) => [c.id, c.statement]));
  return {
    verdict: report.verdict,
    criteria: report.criteria.map((c) => ({
      id: c.criterionId,
      description: statements.get(c.criterionId) ?? c.criterionId,
      critical: c.critical,
      status: c.status,
    })),
    durationMs: report.durationMs,
    costUsd: report.usage.estimatedCostUsd,
  };
}

const wording = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

function changeOf(before: CriterionStatus, after: CriterionStatus): CriterionChange {
  if (before === after) return "unchanged";
  if (after === "PASS") return "fixed";
  if (before === "PASS") return "regressed";
  return "changed";
}

/**
 * Matches the criteria of two runs of a test and says how each changed: by id when the wording is the same, else by
 * wording alone (criteria are renumbered when a requirement is analysed again); the rest are added or removed.
 * Pure. Order: this run's criteria, then the removed ones.
 */
export function compareResults(before: ComparableRun | null, after: ComparableRun): ResultComparison {
  const unmatched = [...(before?.criteria ?? [])];
  const take = (pred: (c: ComparableRun["criteria"][number]) => boolean) => {
    const i = unmatched.findIndex(pred);
    return i < 0 ? undefined : unmatched.splice(i, 1)[0];
  };
  const pairs = after.criteria.map((a) => ({ a, b: take((b) => b.id === a.id && wording(b.description) === wording(a.description)) }));
  for (const p of pairs) if (!p.b) p.b = take((b) => wording(b.description) === wording(p.a.description));

  const criteria: CriterionComparison[] = [
    ...pairs.map(({ a, b }) => ({
      id: a.id,
      description: a.description,
      critical: a.critical,
      before: b?.status ?? null,
      after: a.status,
      change: b ? changeOf(b.status, a.status) : ("added" as const),
    })),
    ...unmatched.map((b) => ({ id: b.id, description: b.description, critical: b.critical, before: b.status, after: null, change: "removed" as const })),
  ];
  const counts: ComparisonCounts = { regressed: 0, fixed: 0, changed: 0, unchanged: 0, added: 0, removed: 0 };
  for (const c of criteria) counts[c.change] += 1;
  return {
    verdict: { before: before?.verdict ?? null, after: after.verdict },
    criteria,
    counts,
    durationMs: { before: before?.durationMs ?? null, after: after.durationMs },
    costUsd: { before: before?.costUsd ?? null, after: after.costUsd },
  };
}

/**
 * One word for a whole run against its previous one: `new` without a baseline; `regressed` when a critical
 * criterion that passed no longer does or the verdict left PASSED; `fixed` when the verdict became PASSED;
 * `changed` for any other difference; else `unchanged`.
 */
export function runChange(comparison: ResultComparison, hasBaseline: boolean): RunChange {
  if (!hasBaseline) return "new";
  const { before, after } = comparison.verdict;
  if (comparison.criteria.some((c) => c.critical && c.change === "regressed") || (before === "PASSED" && after !== "PASSED")) return "regressed";
  if (after === "PASSED" && before !== "PASSED") return "fixed";
  if (before !== after || comparison.criteria.some((c) => c.change !== "unchanged")) return "changed";
  return "unchanged";
}
