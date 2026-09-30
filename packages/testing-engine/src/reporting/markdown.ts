import { STATUS_REASON_TEXT, type CriterionChange, type CriterionResult, type RunVerdict, type TestReport } from "@platform/contracts";
import type { ResultComparison } from "./comparison";

/**
 * The report as a Markdown document (V1.1 F6, `GET /v1/test-runs/:runId/report.md`). Pure. Everything the
 * report holds that a reader needs: the verdict, the summary, every criterion (status, weight, how it was
 * confirmed, expected / actual, reason), diagnostics, the generated test's source and the model usage.
 *
 * Text from the run (requirement, statements, page values, diagnostics) is escaped so it cannot become
 * Markdown structure — no headings, links, images or HTML — and the source sits in a fence longer than any
 * backtick run inside it.
 */

const VERDICT: Record<RunVerdict, string> = { PASSED: "Passed", FAILED: "Failed", BLOCKED: "Blocked", INCONCLUSIVE: "Inconclusive" };
const STATUS: Record<CriterionResult["status"], string> = { PASS: "PASS", FAIL: "FAIL", BLOCKED: "BLOCKED", INCONCLUSIVE: "INCONCLUSIVE" };

/**
 * One line of plain text that cannot become Markdown structure: inline markers (emphasis, code, links,
 * images, HTML, tables, strikethrough) are escaped everywhere; block markers (a heading, list item, quote or
 * numbered item) only at the start, where they act.
 */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/\r?\n|\r/g, " ")
    .trim()
    .replace(/[\\`*_{}[\]<>|~]/g, (c) => `\\${c}`)
    .replace(/^([#+\-=>])/, "\\$1")
    .replace(/^(\d+)([.)])/, "$1\\$2");
}

/** A fenced block that no content can close early. */
export function fenced(content: string, info = ""): string {
  const longest = Math.max(0, ...[...content.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${info}\n${content.replace(/\n$/, "")}\n${fence}`;
}

const when = (iso: string | null) =>
  iso
    ? iso
        .replace("T", " ")
        .replace(/\.\d+Z$/, " UTC")
        .replace(/Z$/, " UTC")
    : "—";

function duration(ms: number | null): string {
  if (ms === null) return "—";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function confirmation(c: CriterionResult): string {
  if (c.verdictSource === "PLAYWRIGHT_RERUN") return "Confirmed by the Playwright rerun";
  if (c.verdictSource === "EXPLORATION_ONLY") return "Not confirmed by a rerun: read from the page while exploring";
  return c.reason ? STATUS_REASON_TEXT[c.reason] : "No reason was recorded";
}

const CHANGE: Record<CriterionChange, string> = {
  fixed: "Fixed",
  regressed: "Regressed",
  changed: "Changed",
  unchanged: "Unchanged",
  added: "New",
  removed: "No longer checked",
};

/** The run this report is compared with (V1.2 F2), and how the results changed. */
export interface MarkdownComparison {
  baselineRunId: string;
  comparison: ResultComparison;
}

export function renderReportMarkdown(report: TestReport, compared: MarkdownComparison | null = null): string {
  const out: string[] = [];
  const statementOf = new Map((report.requirement?.criteria ?? []).map((c) => [c.id, c.statement]));
  const push = (...lines: string[]) => out.push(...lines);

  push("# Test report", "");
  push(`- **Website:** ${escapeMarkdown(report.targetUrl)}`);
  push(`- **Run:** ${escapeMarkdown(report.runId)}${report.rerunOf ? ` (rerun of ${escapeMarkdown(report.rerunOf)})` : ""}`);
  push(`- **Result:** ${report.verdict ? VERDICT[report.verdict] : `${escapeMarkdown(report.lifecycle)} (no verdict)`}`);
  push(
    `- **Started:** ${when(report.startedAt)} · **Finished:** ${when(report.finishedAt)} · **Duration:** ${duration(report.durationMs)}`,
  );
  if (report.partial) push("- **Partial report:** the run stopped before it finished; results are what was recorded.");
  if (report.error) push(`- **Error:** ${escapeMarkdown(report.error.category)} — ${escapeMarkdown(report.error.message)}`);
  push("");

  if (report.requirement) {
    push("## Requirement", "");
    for (const line of report.requirement.originalText.split(/\r?\n/).filter((l) => l.trim())) push(`> ${escapeMarkdown(line)}`);
    push("");
  }

  const s = report.summary;
  push("## Summary", "");
  push("| Criteria | Passed | Failed | Blocked | Inconclusive | Confirmed by rerun |", "|---|---|---|---|---|---|");
  push(`| ${s.totalCriteria} | ${s.passed} | ${s.failed} | ${s.blocked} | ${s.inconclusive} | ${s.confirmedByRerun} |`, "");
  if (s.nonCritical.total > 0) {
    push(
      `${s.nonCritical.total} non-critical ${s.nonCritical.total === 1 ? "criterion" : "criteria"} (${s.nonCritical.notPassed} did not pass): reported, but the verdict ignores them.`,
      "",
    );
  }

  if (compared) {
    const { comparison: c } = compared;
    const verdictText = (v: RunVerdict | null) => (v ? VERDICT[v] : "no verdict");
    push("## Compared with the previous run", "");
    push(`- **Previous run:** ${escapeMarkdown(compared.baselineRunId)}`);
    push(`- **Result:** ${verdictText(c.verdict.before)} → ${verdictText(c.verdict.after)}`);
    push(`- **Criteria:** ${c.counts.regressed} regressed, ${c.counts.fixed} fixed, ${c.counts.changed} changed, ${c.counts.unchanged} unchanged`, "");
    const changed = c.criteria.filter((x) => x.change !== "unchanged");
    if (changed.length > 0) {
      push("| Criterion | Before | Now | Change |", "|---|---|---|---|");
      for (const x of changed) {
        push(`| ${escapeMarkdown(x.id)} — ${escapeMarkdown(x.description)} | ${x.before ?? "—"} | ${x.after ?? "—"} | ${CHANGE[x.change]} |`);
      }
      push("");
    }
  }

  push("## Criteria", "");
  if (report.criteria.length === 0) push("No criterion results were recorded.", "");
  for (const c of report.criteria) {
    const statement = statementOf.get(c.criterionId) ?? `Criterion ${c.criterionId}`;
    push(`### ${escapeMarkdown(c.criterionId)} — ${STATUS[c.status]}${c.critical ? "" : " (non-critical)"}`, "");
    push(escapeMarkdown(statement), "");
    push(`- **How it was decided:** ${escapeMarkdown(confirmation(c))}`);
    push(`- **Expected:** ${escapeMarkdown(c.expected)}`);
    push(`- **Actual:** ${c.actual ? escapeMarkdown(c.actual) : "—"}`);
    if (c.aiNote) push(`- **AI note (never a status):** ${escapeMarkdown(c.aiNote)}`);
    if (c.evidenceArtifactIds.length > 0) push(`- **Evidence:** ${c.evidenceArtifactIds.map(escapeMarkdown).join(", ")}`);
    push("");
  }

  if (report.diagnostics.length > 0) {
    push("## Diagnostics", "");
    for (const d of report.diagnostics)
      push(`- ${d.criterionId ? `**${escapeMarkdown(d.criterionId)}:** ` : ""}${escapeMarkdown(d.summary)}`);
    push("");
  }

  if (report.generatedTest) {
    const t = report.generatedTest;
    push("## Generated Playwright test", "");
    if (report.playwright) push(`Rerun: ${escapeMarkdown(report.playwright.status)} in ${duration(report.playwright.durationMs)}.`, "");
    for (const n of t.notCompiled) push(`- Not compiled: ${escapeMarkdown(n.criterionId)} — ${escapeMarkdown(n.reason)}`);
    if (t.notCompiled.length > 0) push("");
    push(fenced(t.source, "ts"), "");
  }

  const u = report.usage;
  push("## Model usage", "");
  push(
    `${u.llmCalls} model calls · ${u.inputTokens} input and ${u.outputTokens} output tokens · estimated cost $${u.estimatedCostUsd.toFixed(4)}`,
    "",
  );
  return `${out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`;
}
