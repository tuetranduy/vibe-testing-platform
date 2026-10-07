import { useCallback, useEffect, useState } from "react";
import { getArtifactUrl } from "./api";

/**
 * The one place that fetches artifact URLs (LiveEvidence and the report's ArtifactList). Every artifact's signed
 * URL is fetched straight away: since 2026-10-07 nothing is hidden behind a reveal step, credentials entered during
 * a run included. Signed URLs are short-lived, so a failed load refetches (a bounded number of times).
 */
export interface ArtifactRef {
  runId: string;
  artifactId: string;
}

export async function fetchArtifactUrl(ref: ArtifactRef): Promise<{ url: string; expiresAt: string }> {
  return getArtifactUrl(ref.runId, ref.artifactId);
}

export type ArtifactUrlState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; url: string; expiresAt: string }
  | { status: "error"; message: string };

const MAX_REFRESHES = 2;

export interface UseArtifactUrl {
  state: ArtifactUrlState;
  /** The URL failed to load or has expired: fetch a fresh one, up to a limit. */
  onLoadError(): void;
}

export function useArtifactUrl(ref: ArtifactRef | null): UseArtifactUrl {
  const key = ref ? `${ref.runId}/${ref.artifactId}` : null;
  const [attempt, setAttempt] = useState({ key, n: 0 });
  const [state, setState] = useState<ArtifactUrlState>({ status: "idle" });
  const n = attempt.key === key ? attempt.n : 0;

  useEffect(() => {
    if (!ref) {
      setState({ status: "idle" });
      return;
    }
    if (n > MAX_REFRESHES) {
      setState({ status: "error", message: "The file couldn't be loaded." });
      return;
    }
    let live = true;
    setState({ status: "loading" });
    fetchArtifactUrl(ref).then(
      (r) => live && setState({ status: "ready", url: r.url, expiresAt: r.expiresAt }),
      (err: unknown) =>
        live && setState({ status: "error", message: err instanceof Error ? err.message : "The file couldn't be loaded." }),
    );
    return () => {
      live = false;
    };
    // ref is identified by key; a new object for the same artifact must not refetch.
  }, [key, n]);

  const onLoadError = useCallback(() => setAttempt({ key, n: n + 1 }), [key, n]);
  return { state, onLoadError };
}
