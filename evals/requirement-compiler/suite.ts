/**
 * Requirement-compiler eval: compiles each case with the real provider and scores the structure of
 * the result (criterion count, outcome kinds, ambiguity flagging). Scores are for tracking prompt /
 * model changes against evals/BASELINE.md — they never fail CI.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TestDataValueSchema } from "@platform/contracts";
import type { LlmClient } from "@platform/llm";
import { PageInventorySchema, compileRequirement } from "@platform/testing-engine";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { describeError, report, type CaseResult, type UsageMeter } from "../usage";

const OUTCOME_KINDS = ["visible", "text_matches", "numeric_compare", "numeric_delta", "collection_contains", "semantic"] as const;
const Kind = z.enum(OUTCOME_KINDS);

export const EvalCaseSchema = z.object({
  id: z.string().min(1),
  tags: z.array(z.string()).default([]),
  input: z.string().min(10),
  testDataKeys: z.array(z.string()).default([]),
  /**
   * Test data values, for cases whose expected numbers come from test data (post-validation accepts a
   * number only if the requirement or a testData value states it). Keys listed only in `testDataKeys`
   * get the placeholder "value". Values never reach the model, only their keys.
   */
  testData: z.record(z.string(), TestDataValueSchema).default({}),
  secretNames: z.array(z.string()).default([]),
  /**
   * Pages of the live site as the analysis reads them (V1.3, KI-041), e.g. recorded from the demo shop: the compile
   * then sees them like a real run does. The criteria must be the same as without them — pages never add, drop or
   * weaken one.
   */
  pages: z.array(z.object({ url: z.string().url(), inventory: PageInventorySchema })).default([]),
  expect: z.object({
    criteriaCount: z.object({ min: z.number().int().min(1), max: z.number().int().min(1) }),
    /** Each entry must be matched by at least one criterion; a list entry means "any of these kinds". */
    requiredOutcomeKinds: z.array(z.union([Kind, z.array(Kind).min(1)])).default([]),
    mustFlagAmbiguous: z.boolean(),
    /**
     * Every test_data / secret precondition names a provided key or secret. Off by default: a case whose
     * requirement needs an input that was not provided expects the precondition with the name it needs.
     */
    onlyProvidedInputRefs: z.boolean().default(false),
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
export function scoreCase(
  c: EvalCase,
  criteria: { expectedOutcome: { kind: string }; ambiguity: unknown; preconditions: { kind: string; ref?: string | null }[] }[],
): string[] {
  const failures: string[] = [];
  const { min, max } = c.expect.criteriaCount;
  if (criteria.length < min || criteria.length > max) failures.push(`criteria count ${criteria.length} not in [${min}, ${max}]`);
  const kinds = new Set(criteria.map((x) => x.expectedOutcome.kind));
  for (const required of c.expect.requiredOutcomeKinds) {
    const anyOf = Array.isArray(required) ? required : [required];
    if (!anyOf.some((k) => kinds.has(k))) failures.push(`no criterion with outcome kind ${anyOf.join(" | ")} (got ${[...kinds].join(", ")})`);
  }
  if (c.expect.mustFlagAmbiguous && !criteria.some((x) => x.ambiguity !== null)) failures.push("expected an ambiguous criterion, none flagged");
  if (c.expect.onlyProvidedInputRefs) {
    const provided = { test_data: new Set(Object.keys(caseTestData(c))), secret: new Set(c.secretNames) };
    for (const p of criteria.flatMap((x) => x.preconditions)) {
      if ((p.kind === "test_data" || p.kind === "secret") && !provided[p.kind].has(p.ref ?? "")) {
        failures.push(`${p.kind} precondition names "${p.ref ?? ""}", which was not provided`);
      }
    }
  }
  return failures;
}

/** The case's testData: its explicit values, plus the placeholder "value" for keys listed without one. */
export function caseTestData(c: EvalCase): Record<string, z.infer<typeof TestDataValueSchema>> {
  return { ...Object.fromEntries(c.testDataKeys.map((k) => [k, "value"])), ...c.testData };
}

export async function runRequirementCompilerSuite(llm: LlmClient, cases: EvalCase[], meter: UsageMeter): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  for (const c of cases) {
    const runId = `eval_${c.id}`;
    let failures: string[];
    try {
      const draft = await compileRequirement(llm, {
        runId,
        originalText: c.input,
        testData: caseTestData(c),
        secretNames: c.secretNames,
        signal: AbortSignal.timeout(180_000),
        deadlineAt: null,
        redact: (v) => v,
        ...(c.pages.length > 0 ? { site: { pages: c.pages, screenshot: null } } : {}),
      });
      failures = scoreCase(c, draft.criteria);
    } catch (err) {
      failures = [`compile failed: ${describeError(err)}`];
    }
    // Every request the client made for this case, including those of a compile that threw.
    const result = { id: c.id, passed: failures.length === 0, failures, ...meter.take(runId) };
    results.push(result);
    report(result);
  }
  return results;
}
