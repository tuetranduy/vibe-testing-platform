import { SuggestionSetSchema, type SuggestionSet, type SuggestionSetDraft } from "@platform/contracts";
import { eq } from "drizzle-orm";
import type { Executor } from "./client";
import { NotFoundError, StaleTransitionError, UnknownSuggestionError } from "./errors";
import { RunRepository, type TestRun } from "./run-repository";
import { runSuggestions, testRuns } from "./schema";

export interface SelectSuggestionInput {
  suggestionId: string;
  /** The text the run will test: the suggestion's own, or the user's edit (redacted by key by the API). */
  requirement: string;
  edited: boolean;
}

/** A blank-requirement run's suggested tests (spec 2026-09-28-suggest-tests, section 3). */
export class SuggestionRepository {
  constructor(private readonly db: Executor) {}

  /** Stores the survey's suggestions for a run, nothing selected yet. One set per run. */
  async save(runId: string, draft: SuggestionSetDraft): Promise<SuggestionSet> {
    const set = SuggestionSetSchema.parse({ ...draft, selected: null });
    const now = new Date();
    await this.db.insert(runSuggestions).values({ runId, json: set, createdAt: now, updatedAt: now });
    return set;
  }

  async get(runId: string): Promise<SuggestionSet | null> {
    const [row] = await this.db.select().from(runSuggestions).where(eq(runSuggestions.runId, runId));
    return row ? SuggestionSetSchema.parse(row.json) : null;
  }

  /**
   * Selecting writes the requirement, in one transaction under the run's row lock: the set's
   * `selected`, the run's `request_json.requirement`, and AWAITING_SELECTION → ANALYZING_REQUIREMENT
   * with a fresh heartbeat (so the reaper leaves the run alone until the worker picks it up).
   * A run no longer AWAITING_SELECTION → StaleTransitionError, and nothing is written.
   */
  async select(runId: string, input: SelectSuggestionInput): Promise<{ run: TestRun; set: SuggestionSet }> {
    return this.db.transaction(async (tx) => {
      const [locked] = await tx.select({ lifecycle: testRuns.lifecycle }).from(testRuns).where(eq(testRuns.id, runId)).for("update");
      if (!locked) throw new NotFoundError("TestRun", runId);
      if (locked.lifecycle !== "AWAITING_SELECTION") throw new StaleTransitionError(runId, "AWAITING_SELECTION", locked.lifecycle);

      const [row] = await tx.select().from(runSuggestions).where(eq(runSuggestions.runId, runId));
      if (!row) throw new NotFoundError("SuggestionSet", runId);
      const current = SuggestionSetSchema.parse(row.json);
      if (!current.suggestions.some((s) => s.id === input.suggestionId)) throw new UnknownSuggestionError(input.suggestionId);

      const set = SuggestionSetSchema.parse({ ...current, selected: { suggestionId: input.suggestionId, edited: input.edited } });
      const now = new Date();
      await tx.update(runSuggestions).set({ json: set, updatedAt: now }).where(eq(runSuggestions.runId, runId));
      const runs = new RunRepository(tx);
      await runs.setRequirement(runId, input.requirement);
      const run = await runs.transition(runId, "AWAITING_SELECTION", "ANALYZING_REQUIREMENT", { heartbeatAt: now });
      return { run, set };
    });
  }
}
