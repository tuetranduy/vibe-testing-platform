import type { ArtifactSensitivity, ArtifactType } from "@platform/contracts";
import { ArtifactRepository, type Database } from "@platform/db";
import { StorageError, type ArtifactStorage } from "@platform/storage";
import type { WorkerMetrics } from "./metrics";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ArtifactRetention {
  artifactRetentionDays: number;
  secretArtifactRetentionDays: number;
}

export interface StoreArtifactDeps {
  db: Database;
  storage: ArtifactStorage;
  config: ArtifactRetention;
  now?: () => Date;
  metrics?: Pick<WorkerMetrics, "artifactUploadFailures">;
}

export interface StoreArtifactInput {
  tenantId: string;
  runId: string;
  type: ArtifactType;
  fileName: string;
  body: Buffer;
  contentType: string;
  sensitivity: ArtifactSensitivity;
  /** When given, the stored object's SHA-256 must match (what was scrubbed is what was stored). */
  sha256?: string;
}

/**
 * One artifact: object storage, then its `artifacts` row, whose expiry follows its sensitivity
 * (SECRET_BEARING artifacts are kept for a shorter time). If the row cannot be written — or the
 * stored bytes are not the expected ones — the object is removed: nothing would ever expire it.
 */
export async function storeArtifact(deps: StoreArtifactDeps, input: StoreArtifactInput): Promise<{ artifactId: string }> {
  const now = deps.now ?? (() => new Date());
  const { tenantId, runId, type, fileName, body, contentType, sensitivity } = input;
  const stored = await deps.storage.put({ tenantId, runId, type, fileName, body, contentType, sensitivity }).catch((err: unknown) => {
    deps.metrics?.artifactUploadFailures.inc();
    throw err;
  });
  const days = sensitivity === "SECRET_BEARING" ? deps.config.secretArtifactRetentionDays : deps.config.artifactRetentionDays;
  try {
    if (input.sha256 !== undefined && stored.sha256 !== input.sha256) {
      throw new StorageError(`stored ${type} does not match its SHA-256`, { operation: "put", objectKey: stored.objectKey });
    }
    const row = await new ArtifactRepository(deps.db).create({
      tenantId,
      runId,
      type,
      objectKey: stored.objectKey,
      sha256: stored.sha256,
      bytes: stored.bytes,
      contentType,
      sensitivity,
      expiresAt: new Date(now().getTime() + days * DAY_MS),
    });
    return { artifactId: row.id };
  } catch (err) {
    await deps.storage.delete(stored.objectKey).catch(() => {});
    throw err;
  }
}
