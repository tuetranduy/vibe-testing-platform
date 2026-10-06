/**
 * Planner eval: plans each case's hand-written confirmed requirement with the real provider and
 * scores the result — the model contract holds (no ContractError), the expected step kinds, login
 * shape and input references are present, and the deterministic blocking matches exactly. Scores are
 * for tracking prompt / model changes against evals/BASELINE.md — they never fail CI.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BlockReasonSchema,
  CriterionIdSchema,
  InputRefSchema,
  NormalizedRequirementSchema,
  PlannedStepSchema,
  type TestPlan,
} from "@platform/contracts";
import type { LlmClient } from "@platform/llm";
import { planTest } from "@platform/testing-engine";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { describeError, report, type CaseResult, type UsageMeter } from "../usage";

const StepKind = PlannedStepSchema.shape.kind;

export const PlannerEvalCaseSchema = z.object({
  id: z.string().min(1),
  tags: z.array(z.string()).default([]),
  targetUrl: z.string().default("https://shop.example.com"),
  testDataKeys: z.array(z.string()).default([]),
  secretNames: z.array(z.string()).default([]),
  /** The run's effective policy (allowDestructiveActions && environment !== production). */
  allowDestructive: z.boolean().default(false),
  /** A confirmed requirement, written by hand (runId/revision/confirmedAt are filled in). */
  requirement: z.object({ originalText: z.string().min(1), criteria: z.array(z.unknown()).min(1), facts: z.array(z.unknown()) }),
  expect: z.object({
    /** Each kind must appear in the final scenario. */
    requiredStepKinds: z.array(StepKind).default([]),
    maxSteps: z.number().int().min(1).max(50).default(50),
    /** Exactly these criteria are blocked, with these reasons. */
    blocked: z.array(z.object({ criterionId: CriterionIdSchema, reason: BlockReasonSchema })).default([]),
    /** A `login` step exists and a `fill` step with a secret inputRef precedes it. */
    requiresLogin: z.boolean().default(false),
    /** Each ref must be carried by some step. */
    inputRefs: z.array(InputRefSchema).default([]),
    /**
     * A step opens the form's page before the first fill (KI-001): after the opening navigate, a click or navigate comes
     * before the first fill, as a login form is on its own page (the start page has none).
     */
    opensFormBeforeFill: z.boolean().default(false),
    /** Some step is flagged destructive (only meaningful when allowDestructive is true). */
    destructiveStep: z.boolean().default(false),
    /**
     * How many scenarios the plan may have (KI-031). Default exactly one: only a case whose criteria need different
     * starting states may split, so a split anywhere else is scored as splitting too eagerly.
     */
    scenarios: z.object({ min: z.number().int().min(1), max: z.number().int().min(1) }).default({ min: 1, max: 1 }),
  }),
});
export type PlannerEvalCase = z.infer<typeof PlannerEvalCaseSchema>;

const CASES_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "cases");

const confirmedRequirement = (c: PlannerEvalCase) =>
  NormalizedRequirementSchema.parse({ ...c.requirement, runId: `eval_${c.id}`, revision: 1, confirmedAt: "2026-01-01T00:00:00.000Z" });

export function loadPlannerCases(dir = CASES_DIR): PlannerEvalCase[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort();
  const ids = new Set<string>();
  return files.map((f) => {
    const parsed = PlannerEvalCaseSchema.safeParse(parseYaml(readFileSync(join(dir, f), "utf8")));
    if (!parsed.success) throw new Error(`${f}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    const c = parsed.data;
    let criterionIds: string[];
    try {
      criterionIds = confirmedRequirement(c).criteria.map((x) => x.id);
    } catch (err) {
      throw new Error(`${f}: requirement is not a valid NormalizedRequirement: ${describeError(err)}`);
    }
    for (const b of c.expect.blocked) {
      if (!criterionIds.includes(b.criterionId)) throw new Error(`${f}: expect.blocked names unknown criterion ${b.criterionId}`);
    }
    if (ids.has(c.id)) throw new Error(`duplicate case id ${c.id}`);
    ids.add(c.id);
    return c;
  });
}

/** A step description that only applies sometimes ("… if not already shown", "if needed", "when present"). */
const CONDITIONAL = /\b(if|unless|when|in case)\b[^.]*\b(not|already|needed|necessary|present|shown|visible|exists?|available|required)\b/i;

/** Score one plan against a case's expectations. */
export function scorePlan(c: PlannerEvalCase, plan: TestPlan): string[] {
  const failures: string[] = [];
  // Every scenario's steps (V1.1 F9): the golden cases need one; a second one is scored as extra steps.
  const steps = plan.scenarios.flatMap((s) => s.steps);
  const kinds = new Set(steps.map((s) => s.kind));
  for (const k of c.expect.requiredStepKinds) if (!kinds.has(k)) failures.push(`no ${k} step (got ${[...kinds].join(", ")})`);
  if (steps.length > c.expect.maxSteps) failures.push(`${steps.length} steps > max ${c.expect.maxSteps}`);
  // Every case: a step is one action that always applies (KI-001: "Open the account page … if not already shown" found
  // nothing to click once the login had opened it, and exploration stopped).
  for (const step of steps) if (CONDITIONAL.test(step.description)) failures.push(`conditional step ${step.id}: "${step.description}"`);

  const fmt = (xs: { criterionId: string; reason: string }[]) =>
    xs.map((b) => `${b.criterionId}:${b.reason}`).sort().join(", ") || "(none)";
  const got = fmt(plan.blockedCriteria);
  const want = fmt(c.expect.blocked);
  if (got !== want) failures.push(`blocked ${got}, expected ${want}`);

  if (c.expect.requiresLogin) {
    const login = steps.findIndex((s) => s.kind === "login");
    if (login < 0) failures.push("no login step");
    else if (!steps.slice(0, login).some((s) => s.kind === "fill" && s.inputRef?.source === "secret")) {
      failures.push("no fill step with a secret inputRef before the login step");
    }
  }
  for (const ref of c.expect.inputRefs) {
    if (!steps.some((s) => s.inputRef?.source === ref.source && s.inputRef.key === ref.key)) {
      failures.push(`no step carries inputRef ${ref.source}:${ref.key}`);
    }
  }
  if (c.expect.destructiveStep && !steps.some((s) => s.destructive)) failures.push("no step flagged destructive");
  if (c.expect.opensFormBeforeFill) {
    const first = plan.scenarios[0]!.steps;
    const fill = first.findIndex((s) => s.kind === "fill");
    if (fill >= 0 && !first.slice(1, fill).some((s) => s.kind === "click" || s.kind === "navigate")) {
      failures.push(`the first fill (${first[fill]!.id}) comes with no step opening its form`);
    }
  }
  const n = plan.scenarios.length;
  if (n < c.expect.scenarios.min || n > c.expect.scenarios.max) {
    failures.push(`${n} scenarios, expected ${c.expect.scenarios.min}–${c.expect.scenarios.max}`);
  }
  return failures;
}

export async function runPlannerSuite(llm: LlmClient, cases: PlannerEvalCase[], meter: UsageMeter): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  for (const c of cases) {
    const runId = `eval_${c.id}`;
    let failures: string[];
    try {
      const plan = await planTest(llm, {
        runId,
        requirement: confirmedRequirement(c),
        targetUrl: c.targetUrl,
        testDataKeys: c.testDataKeys,
        secretNames: c.secretNames,
        policy: { allowDestructive: c.allowDestructive },
        signal: AbortSignal.timeout(180_000),
        deadlineAt: null,
        redact: (v) => v,
      });
      failures = scorePlan(c, plan);
    } catch (err) {
      failures = [`plan failed: ${describeError(err)}`];
    }
    // Every request the client made for this case, including those of a plan that threw.
    const result = { id: c.id, passed: failures.length === 0, failures, ...meter.take(runId) };
    results.push(result);
    report(result);
  }
  return results;
}
