import { TestReportSchema, type TestReport } from "@platform/contracts";
import { asc, eq } from "drizzle-orm";
import type { Executor } from "./client";
import { newId } from "./ids";
import { diagnosticFindings } from "./schema";

export type DiagnosticFinding = TestReport["diagnostics"][number];
const FindingSchema = TestReportSchema.shape.diagnostics.element;

/**
 * Report diagnostics (Task 18, Ruling R37): model-written notes about a run's decided results. They
 * never hold a status. Validated with the report contract on write and on read; the report stage has
 * already redacted them.
 */
export class DiagnosticFindingRepository {
  constructor(private readonly db: Executor) {}

  async insertMany(runId: string, findings: readonly DiagnosticFinding[]): Promise<void> {
    const parsed = findings.map((f) => FindingSchema.parse(f));
    if (parsed.length === 0) return;
    // One id base per batch plus the position: rows of a batch share created_at, the id keeps their order.
    const base = newId("diag");
    await this.db.insert(diagnosticFindings).values(
      parsed.map((f, i) => ({ id: `${base}_${String(i).padStart(3, "0")}`, runId, criterionId: f.criterionId, summary: f.summary })),
    );
  }

  async listByRun(runId: string): Promise<DiagnosticFinding[]> {
    const rows = await this.db
      .select()
      .from(diagnosticFindings)
      .where(eq(diagnosticFindings.runId, runId))
      .orderBy(asc(diagnosticFindings.createdAt), asc(diagnosticFindings.id));
    return rows.map((r) => FindingSchema.parse({ criterionId: r.criterionId, summary: r.summary }));
  }
}
