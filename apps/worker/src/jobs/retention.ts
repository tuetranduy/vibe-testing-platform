import { ArtifactRepository, type Database } from "@platform/db";
import type { ArtifactStorage } from "@platform/storage";
import type { WorkerLogger } from "../deps";

export interface RetentionDeps {
  db: Database;
  storage: ArtifactStorage;
  logger: WorkerLogger;
  now?: () => Date;
  batchSize?: number;
}

export interface RetentionResult {
  deleted: number;
  failed: number;
}

/**
 * Daily (Task 22): deletes artifacts past `expiresAt` — object first, then row. `expiresAt` was
 * stamped at creation from the artifact's sensitivity (SECRET_BEARING 7 days, STANDARD 30 days by
 * default). A row whose object could not be deleted is kept, so the next pass retries it; the
 * cursor moves past it so one bad object never stalls the rest.
 */
export async function retentionJob(deps: RetentionDeps): Promise<RetentionResult> {
  const now = (deps.now ?? (() => new Date()))();
  const repo = new ArtifactRepository(deps.db);
  const result: RetentionResult = { deleted: 0, failed: 0 };
  let cursor: string | undefined;
  for (;;) {
    const batch = await repo.listExpired(now, deps.batchSize ?? 500, cursor);
    if (batch.length === 0) break;
    for (const artifact of batch) {
      try {
        await deps.storage.delete(artifact.objectKey);
        await repo.delete(artifact.id);
        result.deleted += 1;
      } catch (err) {
        result.failed += 1;
        deps.logger.warn(
          { err, runId: artifact.runId, tenantId: artifact.tenantId, artifactId: artifact.id },
          "expired artifact could not be deleted; retrying next pass",
        );
      }
    }
    cursor = batch.at(-1)!.id;
  }
  return result;
}
