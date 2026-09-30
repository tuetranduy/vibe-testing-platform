import { SiteAnalysisSchema, type SiteAnalysis, type SiteAnalysisDraft } from "@platform/contracts";
import { eq } from "drizzle-orm";
import type { Executor } from "./client";
import { runSiteAnalyses } from "./schema";

/** A run's requirement analysis against the live site (V1.3): one per run, rewritten by a new analysis. */
export class SiteAnalysisRepository {
  constructor(private readonly db: Executor) {}

  /** Stores the analysis (replacing an earlier one: a retried analysis job writes it again). */
  async save(runId: string, draft: SiteAnalysisDraft): Promise<SiteAnalysis> {
    const analysis = SiteAnalysisSchema.parse(draft);
    const now = new Date();
    await this.db
      .insert(runSiteAnalyses)
      .values({ runId, json: analysis, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: runSiteAnalyses.runId, set: { json: analysis, updatedAt: now } });
    return analysis;
  }

  async get(runId: string): Promise<SiteAnalysis | null> {
    const [row] = await this.db.select().from(runSiteAnalyses).where(eq(runSiteAnalyses.runId, runId));
    return row ? SiteAnalysisSchema.parse(row.json) : null;
  }

  /** Records which suggested keys became the run's test data; a run without an analysis is left alone. */
  async markApplied(runId: string, keys: readonly string[]): Promise<void> {
    const current = await this.get(runId);
    if (!current) return;
    const appliedKeys = [...new Set([...current.appliedKeys, ...keys])].filter((k) => current.testData.some((t) => t.key === k));
    await this.save(runId, { ...current, appliedKeys });
  }
}
