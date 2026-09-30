import { ArtifactRepository, ExplorationCacheRepository, type Database } from "@platform/db";
import type { ArtifactStorage } from "@platform/storage";
import type { WorkerLogger } from "../deps";

export interface RetentionDeps {
  db: Database;
  storage: ArtifactStorage;
  logger: WorkerLogger;
  now?: () => Date;
  batchSize?: number;
  /** How long one pass may take (real time); what is left waits for the next pass. Default 1 hour. */
  passTimeoutMs?: number;
}

export interface RetentionResult {
  deleted: number;
  failed: number;
  /** The pass reached its time limit before it ran out of expired artifacts. */
  stoppedEarly: boolean;
}

const PASS_TIMEOUT_MS = 3_600_000;

class PassTimeLimitError extends Error {
  constructor() {
    super("retention pass time limit reached");
    this.name = "PassTimeLimitError";
  }
}

/** `work`, or a PassTimeLimitError after `ms`. A call left behind may still settle later; that is ignored. */
async function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PassTimeLimitError()), ms);
  });
  work.catch(() => {});
  try {
    return await Promise.race([work, limit]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Daily (Task 22): deletes artifacts past `expiresAt` — object first, then row. `expiresAt` was
 * stamped at creation from the artifact's sensitivity (SECRET_BEARING 7 days, STANDARD 30 days by
 * default). A row whose object could not be deleted is kept, so the next pass retries it; the
 * cursor moves past it so one bad object never stalls the rest. A pass stops at its time limit,
 * even inside a store call that does not return, so a hung store never holds the retention queue.
 */
export async function retentionJob(deps: RetentionDeps): Promise<RetentionResult> {
  const now = (deps.now ?? (() => new Date()))();
  const deadline = Date.now() + (deps.passTimeoutMs ?? PASS_TIMEOUT_MS);
  const repo = new ArtifactRepository(deps.db);
  const result: RetentionResult = { deleted: 0, failed: 0, stoppedEarly: false };
  let cursor: string | undefined;
  for (;;) {
    const batch = await repo.listExpired(now, deps.batchSize ?? 500, cursor);
    if (batch.length === 0) break;
    for (const artifact of batch) {
      if (Date.now() >= deadline) return stopEarly(deps, result);
      try {
        await within(deps.storage.delete(artifact.objectKey), deadline - Date.now());
        await repo.delete(artifact.id);
        result.deleted += 1;
      } catch (err) {
        result.failed += 1;
        deps.logger.warn(
          { err, runId: artifact.runId, tenantId: artifact.tenantId, artifactId: artifact.id },
          "expired artifact could not be deleted; retrying next pass",
        );
        if (err instanceof PassTimeLimitError) return stopEarly(deps, result);
      }
    }
    cursor = batch.at(-1)!.id;
  }
  return result;
}

function stopEarly(deps: RetentionDeps, result: RetentionResult): RetentionResult {
  result.stoppedEarly = true;
  deps.logger.warn({ deleted: result.deleted, failed: result.failed }, "retention pass reached its time limit; the rest waits for the next pass");
  return result;
}

/** Exploration cache entries unused for this long are deleted by the daily pass (V1.1 F8). */
export const EXPLORATION_CACHE_MAX_IDLE_DAYS = 30;

/** Daily (V1.1 F8): deletes exploration cache entries no run has reused for 30 days. Returns how many. */
export async function pruneExplorationCache(deps: Pick<RetentionDeps, "db" | "now">): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  return new ExplorationCacheRepository(deps.db).deleteUnusedSince(new Date(now.getTime() - EXPLORATION_CACHE_MAX_IDLE_DAYS * 86_400_000));
}
