import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import type { ArtifactSensitivity, ArtifactType } from "@platform/contracts";
import type { StageContext } from "../orchestrator/stages";

/**
 * Rerun evidence collector (Task 17, Step 5). For each file the rerun left behind: SHA-256 → the store
 * port (worker: `ArtifactStorage.put` + `Artifact` row) → `artifact.created`. Files are stored as they
 * are and are STANDARD: a run's secrets are no longer removed from traces (2026-10-07).
 *
 * Storage failures propagate (infrastructure error, like exploration screenshots).
 *
 * The run signal (cancel / hard deadline) is checked per file, before its upload and before its
 * event: after an abort nothing more is uploaded or published, and the ids stored so far are
 * returned (the stage then throws the abort reason).
 */

/** A file of the rerun, inside its workspace (validated by the result parser). */
export interface LocalArtifact {
  type: Extract<ArtifactType, "TRACE" | "SCREENSHOT" | "VIDEO">;
  path: string;
  contentType: string;
  fileName: string;
}

export interface EvidenceUpload {
  type: ArtifactType;
  fileName: string;
  body: Uint8Array;
  contentType: string;
  /** Lower-case hex SHA-256 of `body`. */
  sha256: string;
  sensitivity: ArtifactSensitivity;
}

/** Persistence port, implemented by the worker (object storage + `artifacts` row). */
export interface EvidenceStore {
  save(upload: EvidenceUpload): Promise<{ artifactId: string }>;
}

export interface CollectEvidenceOptions {
  store: EvidenceStore;
  /** What produced the files, for the event messages (default "Rerun"; V1.3: "Exploration" recordings). */
  origin?: "Rerun" | "Exploration";
}

const LABEL: Record<LocalArtifact["type"], string> = { TRACE: "trace", SCREENSHOT: "screenshot", VIDEO: "video" };

export async function collectEvidence(
  ctx: Pick<StageContext, "publish"> & { signal?: AbortSignal | undefined },
  artifacts: LocalArtifact[],
  opts: CollectEvidenceOptions,
): Promise<string[]> {
  const aborted = () => ctx.signal?.aborted === true;
  const sensitivity: ArtifactSensitivity = "STANDARD";
  const origin = opts.origin ?? "Rerun";
  const omitted = async (type: LocalArtifact["type"], reason: string) => {
    if (!aborted()) await ctx.publish({ type: "artifact.omitted", message: `${origin} ${LABEL[type]} omitted`, payload: { type, reason } });
  };

  const ids: string[] = [];
  for (const artifact of artifacts) {
    if (aborted()) break;
    let body: Uint8Array;
    try {
      // A regular file only: never follow a link out of the workspace.
      if (!(await lstat(artifact.path)).isFile()) throw new Error("not a regular file");
      body = await readFile(artifact.path);
    } catch {
      await omitted(artifact.type, `The ${origin.toLowerCase()} did not leave this file behind`);
      continue;
    }
    if (aborted()) break;
    const sha256 = createHash("sha256").update(body).digest("hex");
    const { artifactId } = await opts.store.save({
      type: artifact.type,
      fileName: artifact.fileName,
      body,
      contentType: artifact.contentType,
      sha256,
      sensitivity,
    });
    ids.push(artifactId);
    if (aborted()) break;
    await ctx.publish({
      type: "artifact.created",
      message: `${origin} ${LABEL[artifact.type]} stored`,
      payload: { artifactId, type: artifact.type, sensitivity },
    });
  }
  return ids;
}
