import { TestEventSchema, type TestEvent, type TestEventInput, type TestEventOf, type TestEventType } from "@platform/contracts";
import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import type { Executor } from "./client";
import { NotFoundError } from "./errors";
import { newId } from "./ids";
import { testEvents, testRuns } from "./schema";

type Row = typeof testEvents.$inferSelect;

function toEvent(row: Row): TestEvent {
  return TestEventSchema.parse({
    id: row.id,
    runId: row.runId,
    sequence: row.sequence,
    timestamp: row.timestamp.toISOString(),
    stage: row.stage,
    type: row.type,
    message: row.message,
    payload: row.payload,
  });
}

export class EventRepository {
  constructor(private readonly db: Executor) {}

  /**
   * Validates, allocates the next per-run sequence, and inserts — in one transaction.
   * The UPDATE ... RETURNING row lock serializes concurrent publishers for the same run.
   */
  async append(input: TestEventInput): Promise<TestEvent> {
    const now = new Date();
    const id = newId("evt");
    // Validate before touching the database (sequence 1 is a placeholder for validation only).
    TestEventSchema.parse({ ...input, id, sequence: 1, timestamp: now.toISOString() });

    return this.db.transaction(async (tx) => {
      const [seq] = await tx
        .update(testRuns)
        .set({ nextEventSequence: sqlIncrement() })
        .where(eq(testRuns.id, input.runId))
        .returning({ sequence: testRuns.nextEventSequence });
      if (!seq) throw new NotFoundError("TestRun", input.runId);
      const [row] = await tx
        .insert(testEvents)
        .values({
          id,
          runId: input.runId,
          sequence: seq.sequence,
          type: input.type,
          stage: input.stage,
          message: input.message,
          payload: input.payload,
          timestamp: now,
        })
        .returning();
      return toEvent(row!);
    });
  }

  async listAfter(runId: string, afterSequence: number, limit = 500): Promise<TestEvent[]> {
    const rows = await this.db
      .select()
      .from(testEvents)
      .where(and(eq(testEvents.runId, runId), gt(testEvents.sequence, afterSequence)))
      .orderBy(asc(testEvents.sequence))
      .limit(limit);
    return rows.map(toEvent);
  }

  /** The run's latest event of `type`, or null (e.g. `playwright.completed` for the report, Ruling R36). */
  async findLastOfType<T extends TestEventType>(runId: string, type: T): Promise<TestEventOf<T> | null> {
    const [row] = await this.db
      .select()
      .from(testEvents)
      .where(and(eq(testEvents.runId, runId), eq(testEvents.type, type)))
      .orderBy(desc(testEvents.sequence))
      .limit(1);
    return row ? (toEvent(row) as TestEventOf<T>) : null;
  }
}

function sqlIncrement() {
  return sql`${testRuns.nextEventSequence} + 1`;
}
