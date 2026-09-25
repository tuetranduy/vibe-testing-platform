/**
 * Requirement-compiler eval: compiles each case with the real provider and scores the structure of
 * the result (criterion count, outcome kinds, ambiguity flagging). Scores are for tracking prompt /
 * model changes against evals/BASELINE.md — they never fail CI.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LlmClient } from "@platform/llm";
import { compileRequirement } from "@platform/testing-engine";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { countingLlm, describeError, report, type CaseResult } from "../usage";

const OUTCOME_KINDS = ["visible", "text_matches", "numeric_compare", "numeric_delta", "collection_contains", "semantic"] as const;
const Kind = z.enum(OUTCOME_KINDS);

export const EvalCaseSchema = z.object({
  id: z.string().min(1),
  tags: z.array(z.string()).default([]),
  input: z.string().min(10),
  testDataKeys: z.array(z.string()).default([]),
  secretNames: z.array(z.string()).default([]),
  expect: z.object({
    criteriaCount: z.object({ min: z.number().int().min(1), max: z.number().int().min(1) }),
    /** Each entry must be matched by at least one criterion; a list entry means "any of these kinds". */
    requiredOutcomeKinds: z.array(z.union([Kind, z.array(Kind).min(1)])).default([]),
    mustFlagAmbiguous: z.boolean(),
  }),
});
export type EvalCase = z.infer<typeof EvalCaseSchema>;

const CASES_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "cases");

export function loadCases(dir = CASES_DIR): EvalCase[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort();
  const cases = files.map((f) => {
    const parsed = EvalCaseSchema.safeParse(parseYaml(readFileSync(join(dir, f), "utf8")));
    if (!parsed.success) throw new Error(`${f}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    return parsed.data;
  });
  const ids = new Set<string>();
  for (const c of cases) {
    if (ids.has(c.id)) throw new Error(`duplicate case id ${c.id}`);
    ids.add(c.id);
  }
  return cases;
}

/** Score one compiled requirement against a case's expectations. */
export function scoreCase(c: EvalCase, criteria: { expectedOutcome: { kind: string }; ambiguity: unknown }[]): string[] {
  const failures: string[] = [];
  const { min, max } = c.expect.criteriaCount;
  if (criteria.length < min || criteria.length > max) failures.push(`criteria count ${criteria.length} not in [${min}, ${max}]`);
  const kinds = new Set(criteria.map((x) => x.expectedOutcome.kind));
  for (const required of c.expect.requiredOutcomeKinds) {
    const anyOf = Array.isArray(required) ? required : [required];
    if (!anyOf.some((k) => kinds.has(k))) failures.push(`no criterion with outcome kind ${anyOf.join(" | ")} (got ${[...kinds].join(", ")})`);
  }
  if (c.expect.mustFlagAmbiguous && !criteria.some((x) => x.ambiguity !== null)) failures.push("expected an ambiguous criterion, none flagged");
  return failures;
}

export async function runRequirementCompilerSuite(llm: LlmClient, cases: EvalCase[]): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  for (const c of cases) {
    const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    // Count usage through a wrapper so failed compiles are still accounted for.
    const counting = countingLlm(llm, usage);
    let failures: string[];
    try {
      const draft = await compileRequirement(counting, {
        runId: `eval_${c.id}`,
        originalText: c.input,
        testData: Object.fromEntries(c.testDataKeys.map((k) => [k, "value"])),
        secretNames: c.secretNames,
        signal: AbortSignal.timeout(180_000),
        deadlineAt: null,
        redact: (v) => v,
      });
      failures = scoreCase(c, draft.criteria);
    } catch (err) {
      failures = [`compile failed: ${describeError(err)}`];
    }
    const result = { id: c.id, passed: failures.length === 0, failures, ...usage };
    results.push(result);
    report(result);
  }
  return results;
}
