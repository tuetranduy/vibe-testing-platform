import { TestDataRecordSchema, type TestDataValue } from "@platform/contracts";
import { and, asc, eq } from "drizzle-orm";
import type { Executor } from "./client";
import { newId } from "./ids";
import { testDataSets } from "./schema";
import { isUniqueViolation } from "./user-repository";

export interface TestDataSetRow {
  id: string;
  tenantId: string;
  name: string;
  values: Record<string, TestDataValue>;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Thrown when a name is already used in the tenant. */
export class NameTakenError extends Error {
  constructor(what: string) {
    super(`A ${what} with this name already exists`);
    this.name = "NameTakenError";
  }
}

const toRow = (r: typeof testDataSets.$inferSelect): TestDataSetRow => ({ ...r, values: TestDataRecordSchema.parse(r.values) });

/** Saved test data sets (V1.1 F3), tenant-scoped. */
export class TestDataSetRepository {
  constructor(private readonly db: Executor) {}

  async list(tenantId: string): Promise<TestDataSetRow[]> {
    const rows = await this.db.select().from(testDataSets).where(eq(testDataSets.tenantId, tenantId)).orderBy(asc(testDataSets.name));
    return rows.map(toRow);
  }

  async find(tenantId: string, id: string): Promise<TestDataSetRow | null> {
    const [row] = await this.db
      .select()
      .from(testDataSets)
      .where(and(eq(testDataSets.tenantId, tenantId), eq(testDataSets.id, id)));
    return row ? toRow(row) : null;
  }

  async create(input: {
    tenantId: string;
    name: string;
    values: Record<string, TestDataValue>;
    createdBy: string | null;
  }): Promise<TestDataSetRow> {
    try {
      const [row] = await this.db
        .insert(testDataSets)
        .values({ id: newId("tds"), ...input, values: TestDataRecordSchema.parse(input.values) })
        .returning();
      return toRow(row!);
    } catch (err) {
      if (isUniqueViolation(err)) throw new NameTakenError("test data set");
      throw err;
    }
  }

  /** Replaces the name and values; null when the set does not exist in the tenant. */
  async update(
    tenantId: string,
    id: string,
    input: { name: string; values: Record<string, TestDataValue> },
  ): Promise<TestDataSetRow | null> {
    try {
      const [row] = await this.db
        .update(testDataSets)
        .set({ name: input.name, values: TestDataRecordSchema.parse(input.values), updatedAt: new Date() })
        .where(and(eq(testDataSets.tenantId, tenantId), eq(testDataSets.id, id)))
        .returning();
      return row ? toRow(row) : null;
    } catch (err) {
      if (isUniqueViolation(err)) throw new NameTakenError("test data set");
      throw err;
    }
  }

  async remove(tenantId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(testDataSets)
      .where(and(eq(testDataSets.tenantId, tenantId), eq(testDataSets.id, id)))
      .returning({ id: testDataSets.id });
    return rows.length > 0;
  }
}
