import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CriterionResultSchema,
  TestReportSchema,
  type AcceptanceCriterion,
  type CriterionResult,
  type ExplorationStep,
  type FactRef,
  type NormalizedRequirement,
  type ObservedFact,
  type ProvisionalResult,
  type RerunResult,
  type TestPlan,
} from "@platform/contracts";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ReportInput, StageContext } from "../orchestrator/stages";
import { DiagnosticsOutputSchema, createDiagnostics, type DiagnosticsLlm } from "./diagnostics";
import {
  createReportBuilder,
  createReportStage,
  type Diagnostics,
  type LlmUsageRow,
  type PersistedRunSources,
  type ReportFinding,
} from "./report-builder";

const SECRET = "pw-Hunter2-Secret";
const ref = (key: string, checkpoint: string): FactRef => ({ key, checkpoint });
const before = ref("cartCount", "before_add");
const after = ref("cartCount", "after_add");
const title = ref("pageTitle", "after_add");
const items = ref("cartItems", "cart_page");

const criterion = (id: string, expectedOutcome: AcceptanceCriterion["expectedOutcome"]): AcceptanceCriterion => ({
  id,
  sourceText: "x",
  statement: `Statement of ${id}`,
  expectedOutcome,
  preconditions: [],
  critical: true,
  ambiguity: null,
});
const declared = (r: FactRef, valueType: "number" | "string" | "string_list") => ({ ...r, description: `The ${r.key}`, valueType });
const requirementOf = (criteria: AcceptanceCriterion[]): NormalizedRequirement => ({
  runId: "run_1",
  revision: 1,
  originalText: "x",
  criteria,
  facts: [declared(before, "number"), declared(after, "number"), declared(title, "string"), declared(items, "string_list")],
  confirmedAt: "2026-09-26T10:00:00.000Z",
});

const FOUR = requirementOf([
  criterion("AC-1", { kind: "numeric_compare", left: after, operator: "gt", right: before }),
  criterion("AC-2", { kind: "text_matches", fact: title, match: { mode: "contains", value: "Added", caseSensitive: false } }),
  criterion("AC-3", { kind: "collection_contains", collection: items, item: "iPhone", match: "contains" }),
  criterion("AC-4", { kind: "numeric_compare", left: after, operator: "eq", right: 1 }),
]);

const plan: TestPlan = {
  runId: "run_1",
  requirementRevision: 1,
  scenarios: [
    {
      id: "SC-1",
      title: "Cart",
      criterionIds: ["AC-1", "AC-2", "AC-3", "AC-4"],
      steps: [
        { id: "PS-1", kind: "capture_checkpoint", description: "Capture before", checkpoint: "before_add", criterionIds: [], destructive: false },
        { id: "PS-2", kind: "click", description: "Add to cart", criterionIds: ["AC-1", "AC-4"], destructive: false },
        { id: "PS-3", kind: "capture_checkpoint", description: "Capture after", checkpoint: "after_add", criterionIds: [], destructive: false },
        { id: "PS-4", kind: "capture_checkpoint", description: "Capture cart", checkpoint: "cart_page", criterionIds: [], destructive: false },
      ],
    },
  ],
  blockedCriteria: [],
  stopConditions: [],
};

const step = (index: number, plannedStepId: string, artifactIds: string[] = [], onGoldenPath = true): ExplorationStep => ({
  id: `st_${index}`,
  runId: "run_1",
  index,
  plannedStepId,
  kind: plannedStepId === "PS-2" ? "act" : "checkpoint",
  instruction: `Instruction ${index}`,
  element: null,
  inputRef: null,
  onGoldenPath,
  urlBefore: "https://shop.example.com/",
  urlAfter: "https://shop.example.com/",
  outcome: "SUCCESS",
  blockReason: null,
  error: null,
  startedAt: "2026-09-26T10:00:00.000Z",
  durationMs: 1,
  artifactIds,
  llm: null,
});
const STEPS = [
  step(0, "PS-1", ["art_shot_0"]),
  step(1, "PS-2", ["art_shot_1"]),
  step(2, "PS-2", ["art_shot_retry"], false), // an abandoned attempt, off the golden path
  step(3, "PS-3", ["art_shot_3"]),
  step(4, "PS-4", ["art_shot_4"]),
];

const element = { candidates: [{ strategy: "testId" as const, value: "x" }], chosenIndex: 0, framePath: [] };
const fact = (r: FactRef, value: ObservedFact["value"], stepId: string, provenance: ObservedFact["provenance"] = "DOM_VERIFIED"): ObservedFact => ({
  ...r,
  value,
  provenance,
  read: provenance === "DOM_VERIFIED" ? { element, mode: "text" } : null,
  stepId,
});
const FACTS = [
  fact(before, 0, "st_0"),
  fact(after, 1, "st_3"),
  fact(title, `Added to cart, password ${SECRET}`, "st_3"),
  fact(items, ["iPhone 17 Pro"], "st_4"),
];

const provisional = (criterionId: string, status: ProvisionalResult["status"], factRefs: FactRef[], reason: ProvisionalResult["reason"] = null): ProvisionalResult => ({
  criterionId,
  status,
  reason,
  factRefs,
  expected: `Expected ${criterionId}`,
  actual: status === "PASS" || status === "FAIL" ? `Actual ${criterionId}` : null,
});
const PROVISIONAL = [
  provisional("AC-1", "PASS", [after, before]),
  provisional("AC-2", "PASS", [title]),
  provisional("AC-3", "PASS", [items]),
  provisional("AC-4", "FAIL", [after]),
];
const rerunOf = (perCriterion: RerunResult["perCriterion"], extra: Partial<RerunResult> = {}): RerunResult => ({
  status: Object.values(perCriterion).every((o) => o === "PASSED") ? "PASSED" : "FAILED",
  perCriterion,
  durationMs: 1234,
  errorText: {},
  artifactIds: ["art_trace", "art_video"],
  ...extra,
});

const ctx = {
  runId: "run_1",
  request: { targetUrl: "https://shop.example.com" },
  signal: new AbortController().signal,
  deadlineAt: null,
  now: () => new Date("2026-09-26T10:05:00.000Z"),
  redact: (v: unknown) => JSON.parse(JSON.stringify(v).replaceAll(SECRET, "[REDACTED]")),
  budgetSignal(this: StageContext, ms: number) {
    return AbortSignal.any([this.signal, AbortSignal.timeout(ms)]);
  },
} as unknown as StageContext;
const NOW = ctx.now().getTime();

const input = (over: Partial<ReportInput> = {}): ReportInput => ({
  requirement: FOUR,
  plan,
  exploration: { steps: STEPS, facts: FACTS, stopReason: "COMPLETED" },
  provisional: PROVISIONAL,
  generatedTest: null,
  rerun: rerunOf({ "AC-1": "PASSED", "AC-2": "PASSED", "AC-3": "PASSED", "AC-4": "ASSERTION_FAILED" }),
  startedAt: new Date("2026-09-26T10:00:00.000Z"),
  ...over,
});

const USAGE: LlmUsageRow[] = [
  { inputTokens: 1200, outputTokens: 300, estimatedCostUsd: 0.0054 },
  { inputTokens: 2000, outputTokens: 500, estimatedCostUsd: 0.0135 },
  { inputTokens: 10, outputTokens: 0, estimatedCostUsd: 0 },
];
function fakeStore(usage: LlmUsageRow[] = USAGE) {
  const saved: ReportFinding[][] = [];
  return {
    saved,
    store: () => ({
      saveDiagnostics: async (findings: ReportFinding[]) => void saved.push(findings),
      llmUsage: async () => usage,
    }),
  };
}
const statusesOf = (criteria: CriterionResult[]) => criteria.map((c) => [c.criterionId, c.status, c.reason, c.verdictSource, c.rerunOutcome]);

describe("report stage: summary and verdict", () => {
  it("4 results (3 PASS, 1 FAIL) → summary { 4, 3, 1, 0, 0 }; verdict FAILED", async () => {
    const report = await createReportStage({ store: fakeStore().store })(ctx, input());
    expect(TestReportSchema.parse(report)).toEqual(report);
    expect(report.summary).toMatchObject({ totalCriteria: 4, passed: 3, failed: 1, blocked: 0, inconclusive: 0 });
    expect(report.verdict).toBe("FAILED");
    expect(report.partial).toBe(false);
    expect(report.playwright).toEqual({ status: "FAILED", durationMs: 1234 });
    expect(report.startedAt).toBe("2026-09-26T10:00:00.000Z");
    expect(report.finishedAt).toBe("2026-09-26T10:05:00.000Z");
    expect(report.durationMs).toBe(300_000);
  });

  it("a non-critical FAIL is reported but does not change the verdict (V1.1)", async () => {
    const failing = (await createReportStage({ store: fakeStore().store })(ctx, input())).criteria.find((c) => c.status === "FAIL")!.criterionId;
    const requirement = requirementOf(FOUR.criteria.map((c) => (c.id === failing ? { ...c, critical: false } : c)));
    const report = await createReportStage({ store: fakeStore().store })(ctx, input({ requirement }));
    expect(report.verdict).toBe("PASSED");
    expect(report.criteria.find((c) => c.criterionId === failing)).toMatchObject({ status: "FAIL", critical: false });
    expect(report.criteria.filter((c) => c.critical)).toHaveLength(3);
    expect(report.summary).toMatchObject({ failed: 1, nonCritical: { total: 1, notPassed: 1 } });
  });

  it("confirmedByRerun counts PLAYWRIGHT_RERUN results only", async () => {
    // AC-1 confirmed; AC-2 not reached (EXPLORATION_ONLY); AC-3 not compiled (EXPLORATION_ONLY); AC-4 FAIL confirmed.
    const report = await createReportStage({ store: fakeStore().store })(
      ctx,
      input({ rerun: rerunOf({ "AC-1": "PASSED", "AC-2": "NOT_REACHED", "AC-4": "ASSERTION_FAILED" }) }),
    );
    expect(statusesOf(report.criteria)).toEqual([
      ["AC-1", "PASS", null, "PLAYWRIGHT_RERUN", "PASSED"],
      ["AC-2", "PASS", null, "EXPLORATION_ONLY", "NOT_REACHED"],
      ["AC-3", "PASS", null, "EXPLORATION_ONLY", "UNAVAILABLE"],
      ["AC-4", "FAIL", null, "PLAYWRIGHT_RERUN", "ASSERTION_FAILED"],
    ]);
    expect(report.summary.confirmedByRerun).toBe(2);
  });

  it("reconciles every criterion: no rerun → UNAVAILABLE; MODEL_EXTRACTED evidence → UNVERIFIED_EVIDENCE; disagreement → DISCOVERY_RERUN_DISAGREE", async () => {
    const facts = FACTS.map((f) => (f.key === "cartItems" ? fact(items, ["iPhone 17 Pro"], "st_4", "MODEL_EXTRACTED") : f));
    const none = await createReportStage({ store: fakeStore().store })(ctx, input({ rerun: null, exploration: { steps: STEPS, facts, stopReason: "COMPLETED" } }));
    expect(statusesOf(none.criteria)).toEqual([
      ["AC-1", "PASS", null, "EXPLORATION_ONLY", "UNAVAILABLE"],
      ["AC-2", "PASS", null, "EXPLORATION_ONLY", "UNAVAILABLE"],
      ["AC-3", "INCONCLUSIVE", "UNVERIFIED_EVIDENCE", null, "UNAVAILABLE"],
      ["AC-4", "FAIL", null, "EXPLORATION_ONLY", "UNAVAILABLE"],
    ]);
    const disagree = await createReportStage({ store: fakeStore().store })(ctx, input({ rerun: rerunOf({ "AC-1": "ASSERTION_FAILED", "AC-4": "PASSED" }) }));
    expect(disagree.criteria.filter((c) => c.reason === "DISCOVERY_RERUN_DISAGREE").map((c) => c.criterionId)).toEqual(["AC-1", "AC-4"]);
    expect(disagree.verdict).toBe("INCONCLUSIVE");
  });

  it("a failed criterion carries expected, actual, evidence (rerun evidence + its steps' screenshots) and related steps", async () => {
    const report = await createReportStage({ store: fakeStore().store })(
      ctx,
      input({ rerun: rerunOf({ "AC-1": "PASSED", "AC-2": "PASSED", "AC-3": "PASSED", "AC-4": "ASSERTION_FAILED" }, { errorText: { "AC-4": `Expected 1, received 2 (${SECRET})` } }) }),
    );
    const failed = report.criteria.find((c) => c.status === "FAIL")!;
    expect(failed).toMatchObject({ criterionId: "AC-4", expected: "Expected AC-4", verdictSource: "PLAYWRIGHT_RERUN" });
    // The rerun's error text enriches `actual`, through the run's redactor.
    expect(failed.actual).toBe("Actual AC-4 | Rerun: Expected 1, received 2 ([REDACTED])");
    // Related: the step that produced its fact (st_3) + golden-path steps planned for it (st_1, not the abandoned st_2).
    expect(failed.relatedStepIds).toEqual(["st_1", "st_3"]);
    expect(failed.evidenceArtifactIds).toEqual(["art_trace", "art_video", "art_shot_1", "art_shot_3"]);
    // A rerun-confirmed PASS keeps only its screenshots: the rerun retains trace/video only on failure.
    expect(report.criteria.find((c) => c.criterionId === "AC-1")!.evidenceArtifactIds).toEqual(["art_shot_0", "art_shot_1", "art_shot_3"]);
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });

  it("the rerun's error text is clipped to the contract's limit", async () => {
    const long = "e".repeat(5000);
    const report = await createReportStage({ store: fakeStore().store })(
      ctx,
      input({ rerun: rerunOf({ "AC-4": "ASSERTION_FAILED" }, { errorText: { "AC-4": long } }) }),
    );
    const failed = report.criteria.find((c) => c.criterionId === "AC-4")!;
    expect(failed.actual!.length).toBe(1000);
    expect(CriterionResultSchema.parse(failed)).toEqual(failed);
  });

  it("usage totals match the run's LlmCall rows", async () => {
    const report = await createReportStage({ store: fakeStore().store })(ctx, input());
    expect(report.usage).toEqual({ llmCalls: 3, inputTokens: 3210, outputTokens: 800, estimatedCostUsd: 0.0189 });
  });

  it("the generated test is summarised, without helpers or data", async () => {
    const generatedTest = { id: "gt_1", source: "src", helpersSource: "h", dataJson: "{}", compiledCriteria: ["AC-1"], notCompiled: [{ criterionId: "AC-3", reason: "r" }], notes: ["n"] };
    const report = await createReportStage({ store: fakeStore().store })(ctx, input({ generatedTest }));
    expect(report.generatedTest).toEqual({ id: "gt_1", source: "src", compiledCriteria: ["AC-1"], notCompiled: [{ criterionId: "AC-3", reason: "r" }], notes: ["n"] });
  });
});

/** A structured-output port that records what it was sent and answers with `reply`. */
function fakeLlm(reply: unknown | (() => never)) {
  const calls: Parameters<DiagnosticsLlm["generateStructured"]>[0][] = [];
  const llm: DiagnosticsLlm = {
    generateStructured: (async (req: Parameters<DiagnosticsLlm["generateStructured"]>[0]) => {
      calls.push(req);
      const data = typeof reply === "function" ? (reply as () => never)() : reply;
      const issues = req.check?.(data as never, { corrected: false }) ?? [];
      if (issues.length > 0) throw new Error(`invalid output: ${issues.join("; ")}`);
      return { data, usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 } };
    }) as DiagnosticsLlm["generateStructured"],
  };
  return { llm, calls };
}

const SEMANTIC = requirementOf([
  ...FOUR.criteria,
  criterion("AC-5", { kind: "semantic", description: "The cart page looks tidy" }),
]);
const semanticInput = () =>
  input({ requirement: SEMANTIC, provisional: [...PROVISIONAL, { ...provisional("AC-5", "INCONCLUSIVE", [], "AI_JUDGED_ONLY") }] });

describe("report stage: diagnostics (Ruling R37)", () => {
  const reply = {
    findings: [
      { criterionId: "AC-4", summary: "The badge showed 2, not 1: the product may have been added twice." },
      { criterionId: null, summary: "The rerun failed on AC-4 only." },
    ],
    notes: [{ criterionId: "AC-5", note: "The recorded cart contents suggest a tidy page." }],
  };

  it("the output schema has no status (or verdict) field", () => {
    const json = JSON.stringify(z.toJSONSchema(DiagnosticsOutputSchema));
    expect(json).not.toMatch(/status|verdict|reason/i);
  });

  it("statuses, summary and verdict are identical with diagnostics on and off", async () => {
    const off = await createReportStage({ store: fakeStore().store })(ctx, semanticInput());
    // The model even tries to smuggle a status in: it has nowhere to go.
    const smuggle = { ...reply, findings: reply.findings.map((f) => ({ ...f, status: "PASS" })) };
    const on = await createReportStage({ store: fakeStore().store, diagnostics: () => createDiagnostics(fakeLlm(smuggle).llm) })(ctx, semanticInput());
    expect(statusesOf(on.criteria)).toEqual(statusesOf(off.criteria));
    expect(on.criteria.map((c) => c.provisional)).toEqual(off.criteria.map((c) => c.provisional));
    expect(on.summary).toEqual(off.summary);
    expect(on.verdict).toBe(off.verdict);
    expect(off.diagnostics).toEqual([]);
    expect(on.diagnostics).toEqual(reply.findings);
  });

  it("findings are persisted through the store; with diagnostics off nothing is saved", async () => {
    const on = fakeStore();
    await createReportStage({ store: on.store, diagnostics: () => createDiagnostics(fakeLlm(reply).llm) })(ctx, semanticInput());
    expect(on.saved).toEqual([reply.findings]);
    const off = fakeStore();
    await createReportStage({ store: off.store })(ctx, semanticInput());
    expect(off.saved).toEqual([]);
  });

  it("the model receives only redacted, template-built summaries — computed after summary and verdict", async () => {
    const { llm, calls } = fakeLlm(reply);
    await createReportStage({ store: fakeStore().store, diagnostics: () => createDiagnostics(llm) })(ctx, semanticInput());
    expect(calls).toHaveLength(1);
    const req = calls[0]!;
    expect(req).toMatchObject({ stage: "GENERATING_REPORT", runId: "run_1", schemaName: "report_diagnostics", schema: DiagnosticsOutputSchema });
    expect(req.redact).toBe(ctx.redact);
    const sent = JSON.stringify({ system: req.system, messages: req.messages });
    expect(sent).not.toContain(SECRET);
    expect(sent).toContain("[REDACTED]");
    // Template-built: the fixed sections, then one line per criterion; the verdict is already decided.
    const prompt = req.messages[0]!.content as string;
    expect(prompt).toMatch(/^Run verdict: FAILED \(decided; do not re-judge\)\nSummary: 5 criteria — 3 passed, 1 failed, 0 blocked, 1 inconclusive; 4 confirmed by rerun\n/);
    expect(prompt).toContain("- AC-4 [numeric_compare] FAIL (PLAYWRIGHT_RERUN; rerun ASSERTION_FAILED): Statement of AC-4");
    expect(prompt).toContain("- AC-5 [semantic] INCONCLUSIVE (AI_JUDGED_ONLY; rerun UNAVAILABLE): Statement of AC-5");
    expect(prompt).toContain("  outcome: The cart page looks tidy");
    expect(prompt).toContain("Semantic criteria to comment on: AC-5");
    expect(prompt).toContain("- PS-2 click: Add to cart (criteria: AC-1, AC-4)");
    expect(prompt).toContain("- st_2 #2 act PS-2 off-path SUCCESS");
    expect(prompt).toContain('- pageTitle@after_add (DOM_VERIFIED, step st_3): "Added to cart, password [REDACTED]"');
    // Free-form exploration text (step instructions, errors) never goes in; recorded values are clipped.
    expect(prompt).not.toContain("Instruction 1");
  });

  it("recorded values are clipped in the prompt", async () => {
    const { llm, calls } = fakeLlm(reply);
    const facts = [...FACTS.filter((f) => f.key !== "pageTitle"), fact(title, "x".repeat(5000), "st_3")];
    await createReportStage({ store: fakeStore().store, diagnostics: () => createDiagnostics(llm) })(ctx, { ...semanticInput(), exploration: { steps: STEPS, facts, stopReason: "COMPLETED" } });
    const line = (calls[0]!.messages[0]!.content as string).split("\n").find((l) => l.startsWith("- pageTitle@after_add"))!;
    expect(line.length).toBeLessThan(260);
  });

  it("a semantic criterion's note is stored as aiNote; its status stays INCONCLUSIVE / AI_JUDGED_ONLY", async () => {
    const report = await createReportStage({ store: fakeStore().store, diagnostics: () => createDiagnostics(fakeLlm(reply).llm) })(ctx, semanticInput());
    const semantic = report.criteria.find((c) => c.criterionId === "AC-5")!;
    expect(semantic).toMatchObject({ status: "INCONCLUSIVE", reason: "AI_JUDGED_ONLY", verdictSource: null, aiNote: "The recorded cart contents suggest a tidy page." });
    expect(report.criteria.filter((c) => c.criterionId !== "AC-5").every((c) => c.aiNote === null)).toBe(true);
  });

  it("the model may not name unknown criteria or note a criterion that is not semantic (checked → one correction round)", async () => {
    const { llm, calls } = fakeLlm(reply);
    await createReportStage({ store: fakeStore().store, diagnostics: () => createDiagnostics(llm) })(ctx, semanticInput());
    const issues = calls[0]!.check!({ findings: [{ criterionId: "AC-9", summary: "x" }], notes: [{ criterionId: "AC-1", note: "y" }] }, { corrected: false });
    expect(issues).toEqual(["findings[0].criterionId AC-9 is not a criterion of this run", "notes[0].criterionId AC-1 is not a semantic criterion"]);
  });

  it("a diagnostics failure never fails the report: same statuses, no diagnostics, a warning logged", async () => {
    const warn = vi.fn();
    const failing = createDiagnostics(
      fakeLlm(() => {
        throw new Error("provider down");
      }).llm,
    );
    const off = await createReportStage({ store: fakeStore().store })(ctx, semanticInput());
    const saved = fakeStore();
    const report = await createReportStage({ store: saved.store, diagnostics: () => failing, logger: { warn } })(ctx, semanticInput());
    expect(statusesOf(report.criteria)).toEqual(statusesOf(off.criteria));
    expect(report.diagnostics).toEqual([]);
    expect(report.criteria.every((c) => c.aiNote === null)).toBe(true);
    expect(saved.saved).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ runId: "run_1" }), "report diagnostics failed; reporting without them");
  });

  it("cancellation / the hard deadline during diagnostics still ends the run", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    const diagnostics: Diagnostics = async () => {
      controller.abort(reason);
      throw new Error("aborted");
    };
    const stage = createReportStage({ store: fakeStore().store, diagnostics: () => diagnostics });
    await expect(stage({ ...ctx, signal: controller.signal }, input())).rejects.toBe(reason);
  });

  it("diagnostics that exceed their time-box → the report completes without them, statuses unchanged (Ruling R43)", async () => {
    const warn = vi.fn();
    const hanging: Diagnostics = () => new Promise(() => {}); // ignores its signal, never settles
    const off = await createReportStage({ store: fakeStore().store })(ctx, semanticInput());
    const saved = fakeStore();
    const report = await createReportStage({ store: saved.store, diagnostics: () => hanging, diagnosticsTimeoutMs: 20, logger: { warn } })(ctx, semanticInput());
    expect(statusesOf(report.criteria)).toEqual(statusesOf(off.criteria));
    expect(report.summary).toEqual(off.summary);
    expect(report.verdict).toBe(off.verdict);
    expect(report.diagnostics).toEqual([]);
    expect(saved.saved).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ runId: "run_1" }), "report diagnostics failed; reporting without them");
  });

  it("the time-box ends safely before the run's hard deadline: its own signal and an earlier deadline", async () => {
    const seen: { signal: AbortSignal; deadlineAt: Date | null }[] = [];
    const diagnostics: Diagnostics = async (i) => {
      seen.push({ signal: i.signal, deadlineAt: i.deadlineAt });
      return { findings: [], notes: [] };
    };
    // At most half the time left: the other half remains to persist and publish the report.
    await createReportStage({ store: fakeStore().store, diagnostics: () => diagnostics })({ ...ctx, deadlineAt: new Date(NOW + 80) }, semanticInput());
    expect(seen).toHaveLength(1);
    expect(seen[0]!.deadlineAt).toEqual(new Date(NOW + 40));
    expect(seen[0]!.signal).not.toBe(ctx.signal);
    // Without a hard deadline the time-box is the diagnostics timeout.
    await createReportStage({ store: fakeStore().store, diagnostics: () => diagnostics, diagnosticsTimeoutMs: 5_000 })(ctx, semanticInput());
    expect(seen[1]!.deadlineAt).toEqual(new Date(NOW + 5_000));
  });

  it("no time left before the hard deadline → no diagnostics call, the report goes on", async () => {
    const warn = vi.fn();
    const diagnostics = vi.fn<Diagnostics>();
    const report = await createReportStage({ store: fakeStore().store, diagnostics: () => diagnostics, logger: { warn } })({ ...ctx, deadlineAt: new Date(NOW) }, semanticInput());
    expect(diagnostics).not.toHaveBeenCalled();
    expect(report.verdict).toBe("FAILED");
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ runId: "run_1" }), "no time left for report diagnostics; reporting without them");
  });

  it("nothing to diagnose (every criterion PASS, none semantic) → no model call", async () => {
    const { llm, calls } = fakeLlm(reply);
    const all = input({ requirement: requirementOf(FOUR.criteria.slice(0, 3)), provisional: PROVISIONAL.slice(0, 3) });
    const report = await createReportStage({ store: fakeStore().store, diagnostics: () => createDiagnostics(llm) })(ctx, all);
    expect(report.verdict).toBe("PASSED");
    expect(calls).toHaveLength(0);
  });
});

const persisted = (over: Partial<PersistedRunSources> = {}): PersistedRunSources => ({
  run: {
    runId: "run_1",
    lifecycle: "COMPLETED",
    verdict: "FAILED",
    errorCategory: null,
    errorMessage: null,
    targetUrl: "https://shop.example.com",
    startedAt: new Date("2026-09-26T10:00:00.000Z"),
    finishedAt: new Date("2026-09-26T10:05:00.000Z"),
  },
  requirement: FOUR,
  plan,
  steps: STEPS,
  facts: FACTS,
  results: [],
  generatedTest: null,
  playwright: { status: "FAILED", durationMs: 1234, perCriterion: { "AC-1": "PASSED", "AC-2": "PASSED", "AC-3": "PASSED", "AC-4": "ASSERTION_FAILED" } },
  diagnostics: [{ criterionId: "AC-4", summary: "stored finding" }],
  llmCalls: USAGE,
  ...over,
});

describe("@platform/testing-engine/reporting entry point (Ruling R36)", () => {
  it("imports only the contracts, zod and pure modules, so the API never loads Stagehand, a browser or an LLM client", () => {
    const seen = new Set<string>();
    const external = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const [statement, spec] of readFileSync(file, "utf8").matchAll(/(?:import|export)[^;]*?from\s+"([^"]+)"/g)) {
        if (spec!.startsWith(".")) visit(path.resolve(path.dirname(file), `${spec}.ts`));
        // A type-only import is erased at runtime: StageContext's `llm` names @platform/llm's LlmClient type.
        else if (!/^(?:import|export)\s+type\s/.test(statement)) external.add(spec!);
      }
    };
    visit(fileURLToPath(new URL("./index.ts", import.meta.url)));
    expect([...external].sort()).toEqual(["@platform/contracts"]);
    const src = fileURLToPath(new URL("..", import.meta.url));
    expect([...seen].map((f) => path.relative(src, f)).sort()).toEqual([
      "orchestrator/stages.ts",
      "reconciliation/reconcile.ts",
      "reporting/index.ts",
      "reporting/report-builder.ts",
      "reporting/rerun-only.ts",
      "shared/fact-values.ts",
      "verification/aggregate.ts",
      "verification/normalize.ts",
    ]);
  });
});

describe("buildReport (the API's report over persisted data, Ruling R36)", () => {
  it("COMPLETED: the persisted final results, verdict, rerun status, diagnostics and usage — the same assembler as the worker", async () => {
    const stageReport = await createReportStage({ store: fakeStore().store })(ctx, input());
    const load = vi.fn(async () => persisted({ results: stageReport.criteria }));
    const report = await createReportBuilder(load).buildReport("run_1");
    expect(load).toHaveBeenCalledWith("run_1");
    expect(TestReportSchema.parse(report)).toEqual(report);
    expect(report).toMatchObject({ runId: "run_1", lifecycle: "COMPLETED", verdict: "FAILED", partial: false, error: null });
    expect(report.criteria).toEqual(stageReport.criteria);
    expect(report.summary).toEqual(stageReport.summary);
    expect(report.playwright).toEqual({ status: "FAILED", durationMs: 1234 });
    expect(report.diagnostics).toEqual([{ criterionId: "AC-4", summary: "stored finding" }]);
    expect(report.usage).toEqual({ llmCalls: 3, inputTokens: 3210, outputTokens: 800, estimatedCostUsd: 0.0189 });
    expect(report.durationMs).toBe(300_000);
  });

  it("ERRORED: partial, no verdict, the error; provisional-only rows go through reconcile with rerun UNAVAILABLE (no PASS without deterministic evidence)", async () => {
    const facts = FACTS.map((f) => (f.key === "cartItems" ? fact(items, ["iPhone 17 Pro"], "st_4", "MODEL_EXTRACTED") : f));
    const report = await createReportBuilder(async () =>
      persisted({
        run: { ...persisted().run, lifecycle: "ERRORED", verdict: null, errorCategory: "TIMEOUT", errorMessage: "Run exceeded its deadline", finishedAt: null },
        facts,
        results: [PROVISIONAL[3]!, PROVISIONAL[2]!, PROVISIONAL[0]!], // AC-2 never verified
        playwright: null,
        diagnostics: [],
      }),
    ).buildReport("run_1");
    expect(report).toMatchObject({ lifecycle: "ERRORED", partial: true, verdict: null, error: { category: "TIMEOUT", message: "Run exceeded its deadline" } });
    expect(statusesOf(report.criteria)).toEqual([
      ["AC-1", "PASS", null, "EXPLORATION_ONLY", "UNAVAILABLE"],
      ["AC-3", "INCONCLUSIVE", "UNVERIFIED_EVIDENCE", null, "UNAVAILABLE"],
      ["AC-4", "FAIL", null, "EXPLORATION_ONLY", "UNAVAILABLE"],
    ]);
    expect(report.criteria[2]).toMatchObject({ relatedStepIds: ["st_1", "st_3"], evidenceArtifactIds: ["art_shot_1", "art_shot_3"] });
    expect(report.summary).toMatchObject({ totalCriteria: 3, passed: 1, failed: 1, inconclusive: 1, confirmedByRerun: 0 });
    expect(report.durationMs).toBeNull();
  });

  it("a partial report after a rerun takes each criterion's outcome from the persisted playwright.completed event (Ruling R43)", async () => {
    // Deadline during the report stage: only provisional rows were persisted, but the rerun had run.
    const report = await createReportBuilder(async () =>
      persisted({
        run: { ...persisted().run, lifecycle: "ERRORED", verdict: null, errorCategory: "TIMEOUT", errorMessage: "Run exceeded its deadline" },
        results: PROVISIONAL,
        playwright: { status: "FAILED", durationMs: 1234, perCriterion: { "AC-1": "ASSERTION_FAILED", "AC-2": "PASSED", "AC-4": "NOT_REACHED" } },
      }),
    ).buildReport("run_1");
    expect(statusesOf(report.criteria)).toEqual([
      ["AC-1", "INCONCLUSIVE", "DISCOVERY_RERUN_DISAGREE", null, "ASSERTION_FAILED"], // never PASS / EXPLORATION_ONLY
      ["AC-2", "PASS", null, "PLAYWRIGHT_RERUN", "PASSED"],
      ["AC-3", "PASS", null, "EXPLORATION_ONLY", "UNAVAILABLE"], // not compiled
      ["AC-4", "FAIL", null, "EXPLORATION_ONLY", "NOT_REACHED"],
    ]);
    expect(report).toMatchObject({ partial: true, verdict: null, playwright: { status: "FAILED", durationMs: 1234 } });
    expect(report.playwright).not.toHaveProperty("perCriterion");
    expect(report.summary.confirmedByRerun).toBe(1);
  });

  it("CANCELLED before any result: partial with whatever exists", async () => {
    const report = await createReportBuilder(async () =>
      persisted({ run: { ...persisted().run, lifecycle: "CANCELLED", verdict: null, startedAt: null, finishedAt: null }, plan: null, steps: [], facts: [], results: [], playwright: null, diagnostics: [], llmCalls: [] }),
    ).buildReport("run_1");
    expect(report).toMatchObject({ lifecycle: "CANCELLED", partial: true, verdict: null, error: null, criteria: [], requirement: FOUR });
    expect(report.summary).toEqual({
      totalCriteria: 0,
      passed: 0,
      failed: 0,
      blocked: 0,
      inconclusive: 0,
      confirmedByRerun: 0,
      nonCritical: { total: 0, notPassed: 0 },
    });
    expect(report.usage).toEqual({ llmCalls: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 });
  });
});
