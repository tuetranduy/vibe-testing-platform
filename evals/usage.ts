/** Shared bits for eval suites: per-case results and token/cost accounting around the LLM port. */
import type { GenerateStructuredInput, LlmClient } from "@platform/llm";
import type { RequirementLlm } from "@platform/testing-engine";

export interface CaseResult {
  id: string;
  passed: boolean;
  failures: string[];
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export type Usage = Pick<CaseResult, "inputTokens" | "outputTokens" | "costUsd">;

/** Wraps the client so usage is counted even when the stage under test throws afterwards. */
export function countingLlm(llm: LlmClient, usage: Usage): RequirementLlm {
  return {
    generateStructured: async <T>(input: GenerateStructuredInput<T>) => {
      const res = await llm.generateStructured(input);
      usage.inputTokens += res.usage.inputTokens;
      usage.outputTokens += res.usage.outputTokens;
      usage.costUsd += res.usage.estimatedCostUsd;
      return res;
    },
  };
}

export function report(result: CaseResult): void {
  console.log(`${result.passed ? "PASS" : "FAIL"}  ${result.id}${result.passed ? "" : `\n      - ${result.failures.join("\n      - ")}`}`);
}

export const describeError = (err: unknown): string => (err instanceof Error ? `${err.name}: ${err.message}` : String(err));
