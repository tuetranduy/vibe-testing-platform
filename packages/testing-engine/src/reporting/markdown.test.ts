import { TestReportSchema, type TestReport } from "@platform/contracts";
import { describe, expect, it } from "vitest";
import { escapeMarkdown, fenced, renderReportMarkdown } from "./markdown";

const report = (patch: Partial<TestReport> = {}): TestReport =>
  TestReportSchema.parse({
    runId: "run_1",
    lifecycle: "COMPLETED",
    verdict: "FAILED",
    error: null,
    partial: false,
    targetUrl: "https://shop.example.com/",
    requirement: {
      runId: "run_1",
      revision: 1,
      originalText: "Add a product to the cart.\nThe cart count goes up.",
      criteria: [
        {
          id: "AC-1",
          sourceText: "The cart count goes up.",
          statement: "The cart count goes up",
          expectedOutcome: { kind: "semantic", description: "The cart count goes up" },
          preconditions: [],
          critical: true,
          ambiguity: null,
        },
        {
          id: "AC-2",
          sourceText: "Add a product to the cart.",
          statement: "# Injected *heading* [link](http://evil.example) <img src=x>",
          expectedOutcome: { kind: "semantic", description: "Looks right" },
          preconditions: [],
          critical: false,
          ambiguity: null,
        },
      ],
      facts: [],
      confirmedAt: "2026-09-29T10:00:00.000Z",
    },
    summary: {
      totalCriteria: 2,
      passed: 0,
      failed: 1,
      blocked: 0,
      inconclusive: 1,
      confirmedByRerun: 1,
      nonCritical: { total: 1, notPassed: 1 },
    },
    criteria: [
      {
        criterionId: "AC-1",
        status: "FAIL",
        reason: null,
        factRefs: [],
        expected: "Cart count increases",
        actual: "Stayed at 0 | Rerun: expected 1",
        verdictSource: "PLAYWRIGHT_RERUN",
        rerunOutcome: "ASSERTION_FAILED",
        provisional: { status: "FAIL", reason: null },
        evidenceArtifactIds: ["art_trace"],
        relatedStepIds: [],
        aiNote: null,
        critical: true,
      },
      {
        criterionId: "AC-2",
        status: "INCONCLUSIVE",
        reason: "AI_JUDGED_ONLY",
        factRefs: [],
        expected: "x",
        actual: null,
        verdictSource: null,
        rerunOutcome: "UNAVAILABLE",
        provisional: { status: "INCONCLUSIVE", reason: "AI_JUDGED_ONLY" },
        evidenceArtifactIds: [],
        relatedStepIds: [],
        aiNote: "Looks fine",
        critical: false,
      },
    ],
    generatedTest: {
      id: "gt_1",
      source: "const s = `a ``` b`;\ntest();\n",
      compiledCriteria: ["AC-1"],
      notCompiled: [{ criterionId: "AC-2", reason: "AI-judged" }],
      notes: [],
    },
    playwright: { status: "FAILED", durationMs: 4200 },
    diagnostics: [{ criterionId: "AC-1", summary: "The badge did not update." }],
    usage: { llmCalls: 12, inputTokens: 34000, outputTokens: 5100, estimatedCostUsd: 0.0421 },
    startedAt: "2026-09-29T10:00:00.000Z",
    finishedAt: "2026-09-29T10:01:35.000Z",
    durationMs: 95_000,
    ...patch,
  });

describe("escapeMarkdown", () => {
  it.each([
    ["# heading", "\\# heading"],
    ["- item", "\\- item"],
    ["1. one", "1\\. one"],
    ["*em* _em_ `code`", "\\*em\\* \\_em\\_ \\`code\\`"],
    ["[a](b) ![i](x)", "\\[a\\](b) !\\[i\\](x)"],
    ["<script>", "\\<script\\>"],
    ["a | b\nc", "a \\| b c"],
    ["shop.example.com v1.2 - fine", "shop.example.com v1.2 - fine"],
  ])("%j → %j", (text, expected) => {
    expect(escapeMarkdown(text)).toBe(expected);
  });
});

describe("fenced", () => {
  it("uses a fence longer than any backtick run inside", () => {
    expect(fenced("a ``` b")).toBe("````\na ``` b\n````");
    expect(fenced("plain", "ts")).toBe("```ts\nplain\n```");
  });
});

describe("renderReportMarkdown (V1.1 F6)", () => {
  const md = renderReportMarkdown(report());

  it("leads with the result and the run's facts", () => {
    expect(md.startsWith("# Test report\n\n- **Website:** https://shop.example.com/\n- **Run:** run\\_1\n- **Result:** Failed\n")).toBe(
      true,
    );
    expect(md).toContain("**Duration:** 1m 35s");
    expect(md).toContain("> Add a product to the cart.\n> The cart count goes up.");
  });

  it("has the summary table and the non-critical note", () => {
    expect(md).toContain("| 2 | 0 | 1 | 0 | 1 | 1 |");
    expect(md).toContain("1 non-critical criterion (1 did not pass): reported, but the verdict ignores them.");
  });

  it("describes every criterion: status, weight, how it was decided, expected and actual", () => {
    expect(md).toContain("### AC-1 — FAIL\n\nThe cart count goes up\n\n- **How it was decided:** Confirmed by the Playwright rerun");
    expect(md).toContain("- **Actual:** Stayed at 0 \\| Rerun: expected 1");
    expect(md).toContain("- **Evidence:** art\\_trace");
    expect(md).toContain("### AC-2 — INCONCLUSIVE (non-critical)");
    expect(md).toContain("- **How it was decided:** Only the AI can judge this, and what the page showed did not decide it");
    expect(md).toContain("- **AI note (never a status):** Looks fine");
  });

  it("never lets run text become structure", () => {
    expect(md).toContain("\\# Injected \\*heading\\* \\[link\\](http://evil.example) \\<img src=x\\>");
    expect(md).not.toMatch(/^# Injected/m);
    expect(md).not.toMatch(/(^|[^\\])<img/);
  });

  it("includes diagnostics, the generated source in a safe fence, and usage", () => {
    expect(md).toContain("## Diagnostics\n\n- **AC-1:** The badge did not update.");
    expect(md).toContain("- Not compiled: AC-2 — AI-judged");
    expect(md).toContain("````ts\nconst s = `a ``` b`;\ntest();\n````");
    expect(md).toContain("12 model calls · 34000 input and 5100 output tokens · estimated cost $0.0421");
  });

  it("marks a partial report and a rerun", () => {
    const partial = renderReportMarkdown(
      report({
        lifecycle: "ERRORED",
        verdict: null,
        partial: true,
        error: { category: "TIMEOUT", message: "Hard deadline" },
        rerunOf: "run_0",
      }),
    );
    expect(partial).toContain("- **Run:** run\\_1 (rerun of run\\_0)");
    expect(partial).toContain("- **Result:** ERRORED (no verdict)");
    expect(partial).toContain("- **Partial report:**");
    expect(partial).toContain("- **Error:** TIMEOUT — Hard deadline");
  });
});

describe("renderReportMarkdown — compared with the previous run (V1.2 F2)", () => {
  it("names the previous run, the verdict change and every changed criterion; nothing without a baseline", () => {
    const md = renderReportMarkdown(report(), {
      baselineRunId: "run_0",
      comparison: {
        verdict: { before: "PASSED", after: "FAILED" },
        criteria: [
          { id: "AC-1", description: "Cart | count", critical: true, before: "PASS", after: "FAIL", change: "regressed" },
          { id: "AC-2", description: "Same", critical: true, before: "PASS", after: "PASS", change: "unchanged" },
        ],
        counts: { regressed: 1, fixed: 0, changed: 0, unchanged: 1, added: 0, removed: 0 },
        durationMs: { before: 1, after: 2 },
        costUsd: { before: 0, after: 0 },
      },
    });
    expect(md).toContain("## Compared with the previous run\n\n- **Previous run:** run\\_0\n- **Result:** Passed → Failed\n");
    expect(md).toContain("| AC-1 — Cart \\| count | PASS | FAIL | Regressed |");
    expect(md).not.toContain("| AC-2 — Same");
    expect(md.indexOf("## Compared with the previous run")).toBeLessThan(md.indexOf("## Criteria"));
    expect(renderReportMarkdown(report())).not.toContain("Compared with the previous run");
  });
});

describe("renderReportMarkdown: what the platform understood and assumed (2026-11-11)", () => {
  /** AC-1 stated with an assumption; AC-2 added by the platform. */
  const understood = (patch: Partial<TestReport> = {}, over: { critical1?: boolean; goal?: string } = {}) => {
    const base = report();
    const [ac1, ac2] = base.requirement!.criteria;
    return report({
      ...patch,
      requirement: {
        ...base.requirement!,
        intent: { clarity: "feature", goal: over.goal ?? "A visitor can add a product to the cart", feature: "Cart", notes: ["Left out: a *third* check (the pages read do not show it)"] },
        criteria: [
          { ...ac1!, critical: over.critical1 ?? true, assumption: "'goes up' is checked as: the count is higher than before" },
          { ...ac2!, statement: "The cart lists the product", critical: true, origin: "inferred", rationale: "A product that was added shows in the cart" },
        ],
      },
    });
  };

  it("prints the goal under the requirement and an Assumptions section", () => {
    const md = renderReportMarkdown(understood());
    expect(md).toContain("**What was understood:** A visitor can add a product to the cart");
    const section = md.slice(md.indexOf("## Assumptions"), md.indexOf("## Summary"));
    expect(section.split("\n").filter((l) => l.startsWith("- "))).toEqual([
      "- AC-2 (added by the platform): A product that was added shows in the cart",
      "- AC-1 (assumed): 'goes up' is checked as: the count is higher than before",
      "- Left out: a \\*third\\* check (the pages read do not show it)",
    ]);
  });

  it("marks the result of a criterion the platform added", () => {
    const md = renderReportMarkdown(understood());
    expect(md).toContain("### AC-2 — INCONCLUSIVE (non-critical) (added by the platform)"); // that result row is non-critical
    expect(md).toContain("### AC-1 — FAIL\n");
  });

  it("says a pass rests on assumed checks only when it does; a failure is never softened", () => {
    expect(renderReportMarkdown(understood({ verdict: "PASSED" }, { critical1: false }))).toContain("- **Result:** Passed (on assumed checks)");
    expect(renderReportMarkdown(understood({ verdict: "PASSED" }))).toContain("- **Result:** Passed\n");
    expect(renderReportMarkdown(understood({ verdict: "FAILED" }, { critical1: false }))).toContain("- **Result:** Failed\n");
  });

  it("has no Assumptions section and no goal line for a report without them", () => {
    const md = renderReportMarkdown(report());
    expect(md).not.toContain("## Assumptions");
    expect(md).not.toContain("What was understood");
  });

  it("escapes the goal: it is the model's text", () => {
    const md = renderReportMarkdown(understood({}, { goal: "**bold** <script>alert(1)</script>" }));
    expect(md).not.toContain("<script>");
    expect(md).not.toContain("**bold**");
  });
});
