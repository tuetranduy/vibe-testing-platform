/**
 * Judge eval (KI-046): the unclear-criterion judge (exploration/judge.ts) over pages whose answer is known — the page
 * is relevant or not, and the criterion holds, does not hold, or cannot be told from it. Each case gives the page as
 * the executor reads it (URL, structure, visible text), without a screenshot: the score is the judge reading text
 * only, as it does on a model without image input or when the screenshot fails. Scores are for tracking prompt and
 * model changes against evals/BASELINE.md; they never fail CI.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LlmClient } from "@platform/llm";
import { PageInventorySchema, createCriterionJudge } from "@platform/testing-engine";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { describeError, report, type CaseResult, type UsageMeter } from "../usage";

const Verdict = z.enum(["HOLDS", "DOES_NOT_HOLD", "CANNOT_TELL"]);

export const JudgeEvalCaseSchema = z.object({
  id: z.string().min(1),
  tags: z.array(z.string()).default([]),
  requirement: z.string().min(1),
  criterion: z.object({
    statement: z.string().min(1),
    /** The semantic outcome's description. */
    description: z.string().min(1),
    sourceText: z.string().min(1),
    ambiguity: z.object({ reason: z.string().min(1) }).nullable().default(null),
  }),
  stepDescription: z.string().nullable().default(null),
  url: z.url(),
  inventory: PageInventorySchema.nullable(),
  text: z.string(),
  expect: z.object({
    relevant: z.boolean(),
    /** The verdicts accepted (one when the answer is clear; more where a careful reading may differ). */
    verdict: z.union([Verdict, z.array(Verdict).min(1)]),
    /** Words "observed" must not contain (what an injected instruction asks the judge to write). */
    forbidden: z.array(z.string().min(1)).default([]),
  }),
});
export type JudgeEvalCase = z.infer<typeof JudgeEvalCaseSchema>;

const CASES_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "cases");

export function loadJudgeCases(dir = CASES_DIR): JudgeEvalCase[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort();
  const ids = new Set<string>();
  return files.map((f) => {
    const parsed = JudgeEvalCaseSchema.safeParse(parseYaml(readFileSync(join(dir, f), "utf8")));
    if (!parsed.success) throw new Error(`${f}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    if (ids.has(parsed.data.id)) throw new Error(`duplicate case id ${parsed.data.id}`);
    ids.add(parsed.data.id);
    if (!parsed.data.expect.relevant && [parsed.data.expect.verdict].flat().some((v) => v !== "CANNOT_TELL")) {
      throw new Error(`${f}: a page that is not relevant can only be CANNOT_TELL`);
    }
    return parsed.data;
  });
}

/** Score one judgment against its case. */
export function scoreJudgment(c: JudgeEvalCase, judgment: { relevant: boolean; verdict: string; observed: string }): string[] {
  const failures: string[] = [];
  if (judgment.relevant !== c.expect.relevant) failures.push(`relevant ${judgment.relevant}, expected ${c.expect.relevant}`);
  const accepted = [c.expect.verdict].flat();
  if (!accepted.includes(judgment.verdict as (typeof accepted)[number])) failures.push(`verdict ${judgment.verdict}, expected ${accepted.join(" | ")}`);
  for (const word of c.expect.forbidden) {
    if (judgment.observed.toLowerCase().includes(word.toLowerCase())) failures.push(`"observed" repeats the page's injected "${word}"`);
  }
  return failures;
}

export async function runJudgeSuite(llm: LlmClient, cases: JudgeEvalCase[], meter: UsageMeter): Promise<CaseResult[]> {
  const judge = createCriterionJudge(llm)!;
  const results: CaseResult[] = [];
  for (const c of cases) {
    const runId = `eval_${c.id}`;
    let failures: string[];
    try {
      const { judgment } = await judge.judge({
        requirement: c.requirement,
        criterion: {
          id: "AC-1",
          statement: c.criterion.statement,
          sourceText: c.criterion.sourceText,
          expectedOutcome: { kind: "semantic", description: c.criterion.description },
          ambiguity: c.criterion.ambiguity ? { reason: c.criterion.ambiguity.reason, suggestions: [] } : null,
        },
        stepDescription: c.stepDescription,
        url: c.url,
        inventory: c.inventory,
        text: c.text,
        screenshot: null,
        runId,
        signal: AbortSignal.timeout(180_000),
        deadlineAt: null,
        redact: (v) => v,
      });
      failures = scoreJudgment(c, judgment);
    } catch (err) {
      failures = [`judge failed: ${describeError(err)}`];
    }
    const result = { id: c.id, passed: failures.length === 0, failures, ...meter.take(runId) };
    results.push(result);
    report(result);
  }
  return results;
}
