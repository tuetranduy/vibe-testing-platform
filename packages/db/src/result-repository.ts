import {
  CriterionResultSchema,
  ProvisionalResultSchema,
  TestPlanSchema,
  type CriterionResult,
  type ProvisionalResult,
  type TestPlan,
} from "@platform/contracts";
import { asc, eq } from "drizzle-orm";
import type { Executor } from "./client";
import { newId } from "./ids";
import { criterionResults, testPlans } from "./schema";

export class PlanRepository {
  constructor(private readonly db: Executor) {}

  async save(plan: TestPlan): Promise<TestPlan> {
    const parsed = TestPlanSchema.parse(plan);
    await this.db
      .insert(testPlans)
      .values({ runId: parsed.runId, json: parsed })
      .onConflictDoUpdate({ target: testPlans.runId, set: { json: parsed } });
    return parsed;
  }

  async find(runId: string): Promise<TestPlan | null> {
    const [row] = await this.db.select().from(testPlans).where(eq(testPlans.runId, runId));
    return row ? TestPlanSchema.parse(row.json) : null;
  }
}

/** Criterion results: provisional (after VERIFYING) are overwritten by final (after reconciliation). */
export class ResultRepository {
  constructor(private readonly db: Executor) {}

  async upsert(runId: string, result: CriterionResult | ProvisionalResult): Promise<void> {
    const parsed = "rerunOutcome" in result ? CriterionResultSchema.parse(result) : ProvisionalResultSchema.parse(result);
    await this.db
      .insert(criterionResults)
      .values({ id: newId("cres"), runId, criterionId: parsed.criterionId, status: parsed.status, json: parsed })
      .onConflictDoUpdate({
        target: [criterionResults.runId, criterionResults.criterionId],
        set: { status: parsed.status, json: parsed },
      });
  }

  async listByRun(runId: string): Promise<(CriterionResult | ProvisionalResult)[]> {
    const rows = await this.db
      .select()
      .from(criterionResults)
      .where(eq(criterionResults.runId, runId))
      .orderBy(asc(criterionResults.criterionId));
    return rows.map((r) => r.json as CriterionResult | ProvisionalResult);
  }
}
