import type { RunLifecycle } from "@platform/contracts";
import { asc, eq } from "drizzle-orm";
import type { Executor } from "./client";
import { newId } from "./ids";
import { llmCalls } from "./schema";

export type LlmCallRow = typeof llmCalls.$inferSelect;

/** Structurally identical to @platform/llm's LlmCallRecord (db does not depend on llm). */
export interface NewLlmCall {
  runId: string;
  stage: RunLifecycle;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  latencyMs: number;
  status: string;
}

/** Per-request model usage, written by the worker's LlmClient sink. Holds no prompt or output text. */
export class LlmCallRepository {
  constructor(private readonly db: Executor) {}

  async create(call: NewLlmCall): Promise<LlmCallRow> {
    const [row] = await this.db
      .insert(llmCalls)
      .values({ id: newId("llm"), ...call, latencyMs: Math.round(call.latencyMs) })
      .returning();
    return row!;
  }

  async listByRun(runId: string): Promise<LlmCallRow[]> {
    return this.db.select().from(llmCalls).where(eq(llmCalls.runId, runId)).orderBy(asc(llmCalls.createdAt), asc(llmCalls.id));
  }
}
