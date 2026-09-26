/** Shared bits for eval suites: per-case results and token/cost accounting around the LLM client. */
import type { LlmCallSink } from "@platform/llm";

export interface CaseResult {
  id: string;
  passed: boolean;
  failures: string[];
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export type Usage = Pick<CaseResult, "inputTokens" | "outputTokens" | "costUsd">;

export interface UsageMeter {
  /** Pass as the LlmClient's `recordCall`: it sees every provider request, per attempt. */
  sink: LlmCallSink;
  /** The usage recorded for `runId` so far; resets it. */
  take(runId: string): Usage;
}

/**
 * Counts usage from the client's per-request call records rather than from returned results, so
 * attempts that end in an error still count: a ContractError after the correction round (both
 * requests were billed) and provider errors after retries.
 */
export function createUsageMeter(): UsageMeter {
  const byRun = new Map<string, Usage>();
  return {
    sink: (call) => {
      const u = byRun.get(call.runId) ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 };
      u.inputTokens += call.inputTokens;
      u.outputTokens += call.outputTokens;
      u.costUsd += call.estimatedCostUsd;
      byRun.set(call.runId, u);
    },
    take: (runId) => {
      const u = byRun.get(runId) ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 };
      byRun.delete(runId);
      return u;
    },
  };
}

export function report(result: CaseResult): void {
  console.log(`${result.passed ? "PASS" : "FAIL"}  ${result.id}${result.passed ? "" : `\n      - ${result.failures.join("\n      - ")}`}`);
}

export const describeError = (err: unknown): string => (err instanceof Error ? `${err.name}: ${err.message}` : String(err));
