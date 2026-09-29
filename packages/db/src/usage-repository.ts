import type { RunLifecycle } from "@platform/contracts";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import type { Executor } from "./client";
import type { RunScope } from "./run-repository";
import { llmCalls, testRuns } from "./schema";

export interface UsageTotals {
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export interface UsageRows {
  totals: UsageTotals & { runs: number };
  byDay: { day: string; llmCalls: number; estimatedCostUsd: number }[];
  byModel: (UsageTotals & { provider: string; model: string })[];
  byStage: { stage: RunLifecycle; llmCalls: number; estimatedCostUsd: number }[];
  topRuns: { runId: string; llmCalls: number; estimatedCostUsd: number }[];
}

const num = (v: unknown) => Number(v ?? 0);

/**
 * Model spend (V1.1 F7): `llm_calls` of the scope's runs whose call time is in [from, to). Days are UTC.
 * Aggregated in the database; every number comes back as a JS number.
 */
export class UsageRepository {
  constructor(private readonly db: Executor) {}

  async summarize(scope: RunScope, from: Date, to: Date): Promise<UsageRows> {
    const where = and(
      eq(testRuns.tenantId, scope.tenantId),
      ...(scope.ownerUserId ? [eq(testRuns.ownerUserId, scope.ownerUserId)] : []),
      gte(llmCalls.createdAt, from),
      lt(llmCalls.createdAt, to),
    );
    const sums = {
      llmCalls: sql<number>`count(*)`,
      inputTokens: sql<number>`coalesce(sum(${llmCalls.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${llmCalls.outputTokens}), 0)`,
      estimatedCostUsd: sql<number>`coalesce(sum(${llmCalls.estimatedCostUsd}), 0)`,
    };
    const day = sql<string>`to_char(${llmCalls.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;

    const [totals] = await this.db
      .select({ ...sums, runs: sql<number>`count(distinct ${llmCalls.runId})` })
      .from(llmCalls)
      .innerJoin(testRuns, eq(testRuns.id, llmCalls.runId))
      .where(where);
    const byDay = await this.db
      .select({ day, llmCalls: sums.llmCalls, estimatedCostUsd: sums.estimatedCostUsd })
      .from(llmCalls)
      .innerJoin(testRuns, eq(testRuns.id, llmCalls.runId))
      .where(where)
      .groupBy(day)
      .orderBy(day);
    const byModel = await this.db
      .select({ provider: llmCalls.provider, model: llmCalls.model, ...sums })
      .from(llmCalls)
      .innerJoin(testRuns, eq(testRuns.id, llmCalls.runId))
      .where(where)
      .groupBy(llmCalls.provider, llmCalls.model)
      .orderBy(desc(sums.estimatedCostUsd));
    const byStage = await this.db
      .select({ stage: llmCalls.stage, llmCalls: sums.llmCalls, estimatedCostUsd: sums.estimatedCostUsd })
      .from(llmCalls)
      .innerJoin(testRuns, eq(testRuns.id, llmCalls.runId))
      .where(where)
      .groupBy(llmCalls.stage)
      .orderBy(desc(sums.estimatedCostUsd));
    const topRuns = await this.db
      .select({ runId: llmCalls.runId, llmCalls: sums.llmCalls, estimatedCostUsd: sums.estimatedCostUsd })
      .from(llmCalls)
      .innerJoin(testRuns, eq(testRuns.id, llmCalls.runId))
      .where(where)
      .groupBy(llmCalls.runId)
      .orderBy(desc(sums.estimatedCostUsd), desc(llmCalls.runId))
      .limit(10);

    return {
      totals: {
        runs: num(totals?.runs),
        llmCalls: num(totals?.llmCalls),
        inputTokens: num(totals?.inputTokens),
        outputTokens: num(totals?.outputTokens),
        estimatedCostUsd: num(totals?.estimatedCostUsd),
      },
      byDay: byDay.map((r) => ({ day: r.day, llmCalls: num(r.llmCalls), estimatedCostUsd: num(r.estimatedCostUsd) })),
      byModel: byModel.map((r) => ({
        provider: r.provider,
        model: r.model,
        llmCalls: num(r.llmCalls),
        inputTokens: num(r.inputTokens),
        outputTokens: num(r.outputTokens),
        estimatedCostUsd: num(r.estimatedCostUsd),
      })),
      byStage: byStage.map((r) => ({ stage: r.stage, llmCalls: num(r.llmCalls), estimatedCostUsd: num(r.estimatedCostUsd) })),
      topRuns: topRuns.map((r) => ({ runId: r.runId, llmCalls: num(r.llmCalls), estimatedCostUsd: num(r.estimatedCostUsd) })),
    };
  }
}
