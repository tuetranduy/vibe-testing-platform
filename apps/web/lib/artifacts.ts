import type { ArtifactSensitivity } from "@platform/contracts";
import { useCallback, useEffect, useState } from "react";
import { ApiRequestError, getArtifactUrl } from "./api";

/**
 * The one place that fetches artifact URLs (LiveEvidence and the report's ArtifactList).
 * Rule: a STANDARD artifact's signed URL is fetched automatically; a SECRET_BEARING one (it may
 * show entered credentials) only after the user explicitly asks to reveal it, which the API audits.
 * Signed URLs are short-lived, so a failed load refetches (a bounded number of times).
 */
export interface ArtifactRef {
  runId: string;
  artifactId: string;
  sensitivity: ArtifactSensitivity;
}

export const requiresReveal = (sensitivity: ArtifactSensitivity): boolean => sensitivity === "SECRET_BEARING";

export type ArtifactUrlResult = { kind: "url"; url: string; expiresAt: string } | { kind: "reveal-required" };

export async function fetchArtifactUrl(ref: ArtifactRef, opts: { revealed: boolean }): Promise<ArtifactUrlResult> {
  if (requiresReveal(ref.sensitivity) && !opts.revealed) return { kind: "reveal-required" };
  try {
    const { url, expiresAt } = await getArtifactUrl(ref.runId, ref.artifactId, requiresReveal(ref.sensitivity));
    return { kind: "url", url, expiresAt };
  } catch (err) {
    // Defensive: the API says a reveal is needed even though we thought it was STANDARD.
    if (err instanceof ApiRequestError && err.code === "REVEAL_REQUIRED") return { kind: "reveal-required" };
    throw err;
  }
}

export type ArtifactUrlState =
  | { status: "idle" }
  | { status: "reveal-required" }
  | { status: "loading" }
  | { status: "ready"; url: string; expiresAt: string }
  | { status: "error"; message: string };

const MAX_REFRESHES = 2;

export interface UseArtifactUrl {
  state: ArtifactUrlState;
  /** The user asked to see a SECRET_BEARING artifact. */
  reveal(): void;
  /** The URL failed to load or has expired: fetch a fresh one, up to a limit. */
  onLoadError(): void;
}

export function useArtifactUrl(ref: ArtifactRef | null): UseArtifactUrl {
  const key = ref ? `${ref.runId}/${ref.artifactId}` : null;
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [attempt, setAttempt] = useState({ key, n: 0 });
  const [state, setState] = useState<ArtifactUrlState>({ status: "idle" });
  const revealed = key !== null && revealedKey === key;
  const n = attempt.key === key ? attempt.n : 0;

  useEffect(() => {
    if (!ref) {
      setState({ status: "idle" });
      return;
    }
    if (requiresReveal(ref.sensitivity) && !revealed) {
      setState({ status: "reveal-required" });
      return;
    }
    if (n > MAX_REFRESHES) {
      setState({ status: "error", message: "The file couldn't be loaded." });
      return;
    }
    let live = true;
    setState({ status: "loading" });
    fetchArtifactUrl(ref, { revealed }).then(
      (r) =>
        live && setState(r.kind === "url" ? { status: "ready", url: r.url, expiresAt: r.expiresAt } : { status: "reveal-required" }),
      (err: unknown) =>
        live && setState({ status: "error", message: err instanceof Error ? err.message : "The file couldn't be loaded." }),
    );
    return () => {
      live = false;
    };
    // ref is identified by key + sensitivity; a new object for the same artifact must not refetch.
  }, [key, ref?.sensitivity, revealed, n]);

  const reveal = useCallback(() => setRevealedKey(key), [key]);
  const onLoadError = useCallback(() => setAttempt({ key, n: n + 1 }), [key, n]);
  return { state, reveal, onLoadError };
}
