import { GeneratedTestSchema, type GeneratedTest } from "@platform/contracts";
import { eq } from "drizzle-orm";
import type { Executor } from "./client";
import { generatedTests } from "./schema";

/**
 * The run's generated Playwright test (Task 16, Ruling R28): one per run. Validated with the shared
 * contract on write and on read; the GENERATING_TEST stage has already redacted it.
 */
export class GeneratedTestRepository {
  constructor(private readonly db: Executor) {}

  async save(runId: string, test: GeneratedTest): Promise<GeneratedTest> {
    const parsed = GeneratedTestSchema.parse(test);
    await this.db.insert(generatedTests).values({
      id: parsed.id,
      runId,
      source: parsed.source,
      helpersSource: parsed.helpersSource,
      dataJson: parsed.dataJson,
      compiledCriteria: parsed.compiledCriteria,
      notCompiled: parsed.notCompiled,
      notes: parsed.notes,
    });
    return parsed;
  }

  async findByRun(runId: string): Promise<GeneratedTest | null> {
    const [row] = await this.db.select().from(generatedTests).where(eq(generatedTests.runId, runId));
    if (!row) return null;
    return GeneratedTestSchema.parse({
      id: row.id,
      source: row.source,
      helpersSource: row.helpersSource,
      dataJson: row.dataJson,
      compiledCriteria: row.compiledCriteria,
      notCompiled: row.notCompiled,
      notes: row.notes,
    });
  }
}
