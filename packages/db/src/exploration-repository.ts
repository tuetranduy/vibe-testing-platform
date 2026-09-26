import { ExplorationStepSchema, ObservedFactSchema, type ExplorationStep, type ObservedFact } from "@platform/contracts";
import { asc, eq } from "drizzle-orm";
import type { Executor } from "./client";
import { newId } from "./ids";
import { explorationSteps, observedFacts } from "./schema";

/**
 * Recorded exploration steps (Task 14). JSON is validated with the shared contract on write and on
 * read; rows arrive already redacted from the executor.
 */
export class ExplorationStepRepository {
  constructor(private readonly db: Executor) {}

  async insert(step: ExplorationStep): Promise<ExplorationStep> {
    const parsed = ExplorationStepSchema.parse(step);
    await this.db.insert(explorationSteps).values({ id: parsed.id, runId: parsed.runId, index: parsed.index, json: parsed });
    return parsed;
  }

  async listByRun(runId: string): Promise<ExplorationStep[]> {
    const rows = await this.db.select().from(explorationSteps).where(eq(explorationSteps.runId, runId)).orderBy(asc(explorationSteps.index));
    return rows.map((r) => ExplorationStepSchema.parse(r.json));
  }
}

/** Observed facts, one per (run, key, checkpoint): a retried checkpoint replaces its facts. */
export class ObservedFactRepository {
  constructor(private readonly db: Executor) {}

  async upsert(runId: string, fact: ObservedFact): Promise<ObservedFact> {
    const parsed = ObservedFactSchema.parse(fact);
    await this.db
      .insert(observedFacts)
      .values({ id: newId("fact"), runId, key: parsed.key, checkpoint: parsed.checkpoint, json: parsed })
      .onConflictDoUpdate({ target: [observedFacts.runId, observedFacts.key, observedFacts.checkpoint], set: { json: parsed } });
    return parsed;
  }

  async listByRun(runId: string): Promise<ObservedFact[]> {
    const rows = await this.db
      .select()
      .from(observedFacts)
      .where(eq(observedFacts.runId, runId))
      .orderBy(asc(observedFacts.createdAt), asc(observedFacts.id));
    return rows.map((r) => ObservedFactSchema.parse(r.json));
  }
}
