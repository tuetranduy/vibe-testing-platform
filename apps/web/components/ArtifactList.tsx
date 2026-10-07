"use client";

import type { ArtifactType } from "@platform/contracts";
import { useState, type MouseEvent } from "react";
import { useArtifactUrl } from "../lib/artifacts";
import type { ArtifactInfo } from "../lib/progress-reducer";
import { Icon, type IconName } from "./Icon";
import { formatTime } from "./format";

const TYPE_LABEL: Record<ArtifactType, string> = {
  SCREENSHOT: "Screenshot",
  TRACE: "Trace",
  VIDEO: "Video",
  GENERATED_TEST: "Generated test",
  PLAYWRIGHT_REPORT: "Playwright report",
};

const TYPE_ICON: Record<ArtifactType, IconName> = {
  SCREENSHOT: "image",
  TRACE: "file",
  VIDEO: "video",
  GENERATED_TEST: "code",
  PLAYWRIGHT_REPORT: "file",
};

/** A signed URL this close to expiry is refreshed instead of followed. */
const EXPIRY_MARGIN_MS = 5000;

interface Props {
  runId: string;
  /** In display order (the report's `evidenceArtifactIds`, or every artifact of the run). */
  artifactIds: readonly string[];
  /**
   * What is known about each artifact, from the run's `artifact.created` events (the report carries
   * only ids). An id with no entry is shown as a plain artifact.
   */
  artifacts: ReadonlyMap<string, ArtifactInfo>;
  emptyText?: string;
}

/**
 * The artifact viewer: screenshots inline (with a full-size link), videos playable inline, traces and
 * other files as downloads. Signed URLs come from the shared helper (lib/artifacts.ts).
 */
export function ArtifactList({ runId, artifactIds, artifacts, emptyText = "No evidence was captured." }: Props) {
  if (artifactIds.length === 0) return <p className="muted">{emptyText}</p>;
  return (
    <ul className="artifact-list" aria-label="Evidence">
      {artifactIds.map((id) => (
        <ArtifactItem key={id} runId={runId} artifactId={id} info={artifacts.get(id) ?? null} />
      ))}
    </ul>
  );
}

function ArtifactItem({ runId, artifactId, info }: { runId: string; artifactId: string; info: ArtifactInfo | null }) {
  const { state, onLoadError } = useArtifactUrl({ runId, artifactId });
  const [refreshed, setRefreshed] = useState(false);
  const label = info ? TYPE_LABEL[info.type] : "Artifact";
  const caption = info?.message ?? `Artifact ${artifactId}`;

  /** Follow a link only while its signed URL is still valid; otherwise fetch a fresh one. */
  const guardExpiry = (e: MouseEvent<HTMLAnchorElement>) => {
    if (state.status === "ready" && Date.parse(state.expiresAt) - Date.now() < EXPIRY_MARGIN_MS) {
      e.preventDefault();
      setRefreshed(true);
      onLoadError();
    }
  };

  let body;
  if (state.status === "error") {
    body = (
      <p className="artifact-hidden" role="status">
        <Icon name="warning" /> {state.message}
      </p>
    );
  } else if (state.status === "ready" && info?.type === "SCREENSHOT") {
    body = (
      <>
        {/* Short-lived signed URL: an error means it expired, so fetch a fresh one. */}
        <img className="artifact-image" src={state.url} alt={caption} onError={onLoadError} />
        <a className="artifact-link" href={state.url} target="_blank" rel="noopener noreferrer" onClick={guardExpiry}>
          <Icon name="external" /> Open full size
        </a>
      </>
    );
  } else if (state.status === "ready" && info?.type === "VIDEO") {
    body = (
      <>
        <video className="artifact-video" src={state.url} controls preload="metadata" aria-label={caption} onError={onLoadError} />
        <a className="artifact-link" href={state.url} download onClick={guardExpiry}>
          <Icon name="download" /> Download video
        </a>
      </>
    );
  } else if (state.status === "ready") {
    body = (
      <div className="artifact-file">
        <a className="button button-secondary" href={state.url} download onClick={guardExpiry}>
          <Icon name="download" /> Download {label.toLowerCase()}
        </a>
        {info?.type === "TRACE" && (
          <p className="hint">
            Open it with <code>npx playwright show-trace trace.zip</code>, or drop it on trace.playwright.dev.
          </p>
        )}
      </div>
    );
  } else {
    body = (
      <p className="muted" role="status">
        Loading {label.toLowerCase()}…
      </p>
    );
  }

  return (
    <li className="artifact">
      <div className="artifact-head">
        <Icon name={info ? TYPE_ICON[info.type] : "file"} />
        <span className="artifact-type">{label}</span>
      </div>
      {body}
      <p className="artifact-caption">
        {caption}
        {info && (
          <>
            {" · "}
            <time dateTime={info.timestamp}>{formatTime(info.timestamp)}</time>
          </>
        )}
      </p>
      {refreshed && state.status === "ready" && (
        <p className="hint" role="status">
          The link expired and was refreshed. Select it again.
        </p>
      )}
    </li>
  );
}
