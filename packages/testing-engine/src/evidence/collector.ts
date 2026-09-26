import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import type { ArtifactSensitivity, ArtifactType } from "@platform/contracts";
import type { StageContext } from "../orchestrator/stages";
import { TraceScrubError, scrubTrace } from "./trace-scrubber";

/**
 * Rerun evidence collector (Task 17, Step 5). For each file the rerun left behind: scrub it if it is
 * a trace → SHA-256 → the store port (worker: `ArtifactStorage.put` + `Artifact` row with the
 * retention of its sensitivity) → `artifact.created`. Every file of a run with secrets is
 * SECRET_BEARING (screenshots and videos cannot be scrubbed; they get the shorter retention).
 *
 * A trace that cannot be scrubbed is never uploaded as is: it is dropped with `artifact.omitted`.
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
  /** Lower-case hex SHA-256 of `body` (what is uploaded, i.e. after scrubbing). */
  sha256: string;
  sensitivity: ArtifactSensitivity;
}

/** Persistence port, implemented by the worker (object storage + `artifacts` row). */
export interface EvidenceStore {
  save(upload: EvidenceUpload): Promise<{ artifactId: string }>;
}

export interface CollectEvidenceOptions {
  store: EvidenceStore;
  /** The run's secret values: removed from traces; any secret makes the evidence SECRET_BEARING. */
  secretValues: string[];
}

const LABEL: Record<LocalArtifact["type"], string> = { TRACE: "trace", SCREENSHOT: "screenshot", VIDEO: "video" };

export async function collectEvidence(
  ctx: Pick<StageContext, "publish"> & { signal?: AbortSignal | undefined },
  artifacts: LocalArtifact[],
  opts: CollectEvidenceOptions,
): Promise<string[]> {
  const aborted = () => ctx.signal?.aborted === true;
  const sensitivity: ArtifactSensitivity = opts.secretValues.length > 0 ? "SECRET_BEARING" : "STANDARD";
  const omitted = async (type: LocalArtifact["type"], reason: string) => {
    if (!aborted()) await ctx.publish({ type: "artifact.omitted", message: `Rerun ${LABEL[type]} omitted`, payload: { type, reason } });
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
      await omitted(artifact.type, "The rerun did not leave this file behind");
      continue;
    }
    if (artifact.type === "TRACE") {
      try {
        body = scrubTrace(body, opts.secretValues);
      } catch (err) {
        if (!(err instanceof TraceScrubError)) throw err;
        await omitted("TRACE", "The trace could not be read to remove secrets, so it was not stored");
        continue;
      }
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
      message: `Rerun ${LABEL[artifact.type]} stored`,
      payload: { artifactId, type: artifact.type, sensitivity },
    });
  }
  return ids;
}
