import { NormalizedRequirementSchema, type NormalizedRequirement } from "@platform/contracts";
import { and, desc, eq } from "drizzle-orm";
import type { Executor } from "./client";
import { NotFoundError, RequirementFrozenError, RequirementStateError } from "./errors";
import { newId } from "./ids";
import { requirementRevisions, testRuns } from "./schema";

type Row = typeof requirementRevisions.$inferSelect;

const EDITABLE_LIFECYCLES = ["ANALYZING_REQUIREMENT", "AWAITING_CONFIRMATION"] as const;

function toRequirement(row: Row): NormalizedRequirement {
  return NormalizedRequirementSchema.parse({
    ...(row.json as object),
    runId: row.runId,
    revision: row.revision,
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
  });
}

export class RequirementRepository {
  constructor(private readonly db: Executor) {}

  /**
   * Appends revision n+1. Rejected once any revision is confirmed (RequirementFrozenError), outside
   * ANALYZING_REQUIREMENT / AWAITING_CONFIRMATION, or if originalText differs from revision 1.
   */
  async createRevision(
    runId: string,
    requirement: Omit<NormalizedRequirement, "runId" | "revision" | "confirmedAt"> &
      Partial<Pick<NormalizedRequirement, "runId" | "revision" | "confirmedAt">>,
  ): Promise<NormalizedRequirement> {
    return this.db.transaction(async (tx) => {
      const [run] = await tx
        .select({ lifecycle: testRuns.lifecycle })
        .from(testRuns)
        .where(eq(testRuns.id, runId))
        .for("update");
      if (!run) throw new NotFoundError("TestRun", runId);

      const [latest] = await tx
        .select()
        .from(requirementRevisions)
        .where(eq(requirementRevisions.runId, runId))
        .orderBy(desc(requirementRevisions.revision))
        .limit(1);
      if (latest?.confirmedAt) throw new RequirementFrozenError(runId);
      if (!(EDITABLE_LIFECYCLES as readonly string[]).includes(run.lifecycle)) {
        throw new RequirementStateError(`Criteria cannot change while the run is ${run.lifecycle}`);
      }
      if (latest && (latest.json as NormalizedRequirement).originalText !== requirement.originalText) {
        throw new RequirementStateError("originalText cannot change between revisions");
      }

      const revision = (latest?.revision ?? 0) + 1;
      const parsed = NormalizedRequirementSchema.parse({ ...requirement, runId, revision, confirmedAt: null });
      const [row] = await tx
        .insert(requirementRevisions)
        .values({ id: newId("req"), runId, revision, json: parsed })
        .returning();
      return toRequirement(row!);
    });
  }

  /**
   * A manual rerun (V1.1 F5): the source run's confirmed requirement becomes this new run's revision 1,
   * already confirmed (the criteria were frozen when the source run confirmed them). Only for a run with no
   * revision yet.
   */
  async copyConfirmed(runId: string, source: NormalizedRequirement): Promise<NormalizedRequirement> {
    const parsed = NormalizedRequirementSchema.parse({ ...source, runId, revision: 1, confirmedAt: source.confirmedAt ?? new Date().toISOString() });
    const [row] = await this.db
      .insert(requirementRevisions)
      .values({ id: newId("req"), runId, revision: 1, json: parsed, confirmedAt: new Date(parsed.confirmedAt!) })
      .returning();
    return toRequirement(row!);
  }

  /** Freezes the given revision; it must be the latest and not yet confirmed. */
  async confirm(runId: string, revision: number): Promise<NormalizedRequirement> {
    return this.db.transaction(async (tx) => {
      const [latest] = await tx
        .select()
        .from(requirementRevisions)
        .where(eq(requirementRevisions.runId, runId))
        .orderBy(desc(requirementRevisions.revision))
        .limit(1)
        .for("update");
      if (!latest) throw new NotFoundError("RequirementRevision", runId);
      if (latest.confirmedAt) throw new RequirementFrozenError(runId);
      if (latest.revision !== revision) {
        throw new RequirementStateError(`Revision ${revision} is not the latest (${latest.revision})`);
      }
      const [row] = await tx
        .update(requirementRevisions)
        .set({ confirmedAt: new Date() })
        .where(and(eq(requirementRevisions.id, latest.id)))
        .returning();
      return toRequirement(row!);
    });
  }

  async findLatest(runId: string): Promise<NormalizedRequirement | null> {
    const [row] = await this.db
      .select()
      .from(requirementRevisions)
      .where(eq(requirementRevisions.runId, runId))
      .orderBy(desc(requirementRevisions.revision))
      .limit(1);
    return row ? toRequirement(row) : null;
  }

  async getLatest(runId: string): Promise<NormalizedRequirement> {
    const req = await this.findLatest(runId);
    if (!req) throw new NotFoundError("RequirementRevision", runId);
    return req;
  }
}
