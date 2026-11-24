import { StoredFindingSchema, findingFingerprint, type StoredFinding } from "@platform/contracts";
import { and, asc, desc, eq, ne } from "drizzle-orm";
import type { Executor } from "./client";
import { runFindings } from "./schema";

/**
 * Phase C: a run's exploratory findings (unverified Browser Use hypotheses), apart from every result table. The
 * run's tenant is set by the database from the run; callers scope reads by loading the run for the tenant first.
 */
export class FindingRepository {
  constructor(private readonly db: Executor) {}

  /** Stores a discovery job's findings once: a retried job does not replace findings already reviewed. */
  async saveNew(runId: string, findings: readonly StoredFinding[]): Promise<number> {
    if (findings.length === 0) return 0;
    const rows = findings.map((finding) => {
      const parsed = StoredFindingSchema.parse(finding);
      return { runId, findingId: parsed.id, fingerprint: findingFingerprint(parsed), json: parsed };
    });
    const inserted = await this.db.insert(runFindings).values(rows).onConflictDoNothing().returning({ id: runFindings.findingId });
    return inserted.length;
  }

  async list(runId: string): Promise<StoredFinding[]> {
    const rows = await this.db.select().from(runFindings).where(eq(runFindings.runId, runId)).orderBy(asc(runFindings.findingId));
    return rows.map((row) => StoredFindingSchema.parse(row.json));
  }

  async get(runId: string, findingId: string): Promise<StoredFinding | null> {
    const [row] = await this.db.select().from(runFindings)
      .where(and(eq(runFindings.runId, runId), eq(runFindings.findingId, findingId)));
    return row ? StoredFindingSchema.parse(row.json) : null;
  }

  /** The same problem in the tenant's other runs, newest first (at most `limit`). */
  async recurrences(tenantId: string, finding: StoredFinding, runId: string, limit = 20): Promise<{ runId: string; finding: StoredFinding }[]> {
    const rows = await this.db.select().from(runFindings)
      .where(and(eq(runFindings.tenantId, tenantId), eq(runFindings.fingerprint, findingFingerprint(finding)), ne(runFindings.runId, runId)))
      .orderBy(desc(runFindings.createdAt)).limit(limit);
    return rows.map((row) => ({ runId: row.runId, finding: StoredFindingSchema.parse(row.json) }));
  }

  /** Records a reviewer's change (a dismissal, or the reproduction run that was started). */
  async update(runId: string, finding: StoredFinding): Promise<void> {
    const parsed = StoredFindingSchema.parse(finding);
    await this.db.update(runFindings).set({ json: parsed, updatedAt: new Date() })
      .where(and(eq(runFindings.runId, runId), eq(runFindings.findingId, parsed.id)));
  }
}
