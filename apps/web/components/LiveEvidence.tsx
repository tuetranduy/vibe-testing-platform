"use client";

import { useArtifactUrl } from "../lib/artifacts";
import type { ScreenshotRef } from "../lib/progress-reducer";
import { Icon } from "./Icon";
import { formatTime } from "./format";

interface Props {
  runId: string;
  screenshot: ScreenshotRef | null;
}

/** The latest screenshot of a running run, fetched through the proxy. */
export function LiveEvidence({ runId, screenshot }: Props) {
  const { state, onLoadError } = useArtifactUrl(screenshot ? { runId, artifactId: screenshot.artifactId } : null);

  return (
    <section className="ink evidence" aria-labelledby="evidence-title">
      <div className="evidence-head">
        <h2 id="evidence-title">
          <span className="live-dot" aria-hidden="true" />
          Latest screenshot
        </h2>
      </div>
      {!screenshot ? (
        <div className="evidence-empty">
          <Icon name="image" />
          <p>No screenshot yet. Screenshots appear here as the run captures checkpoints.</p>
        </div>
      ) : state.status === "ready" ? (
        <figure className="evidence-figure">
          {/* Short-lived signed URL: an error means it expired, so fetch a fresh one. */}
          <img src={state.url} alt={screenshot.message} onError={onLoadError} />
          <figcaption>
            <span>{screenshot.message}</span>
            <time dateTime={screenshot.timestamp}>{formatTime(screenshot.timestamp)}</time>
          </figcaption>
        </figure>
      ) : state.status === "error" ? (
        <div className="evidence-empty" role="status">
          <Icon name="warning" />
          <p>{state.message}</p>
        </div>
      ) : (
        <p className="muted" role="status">
          Loading screenshot…
        </p>
      )}
    </section>
  );
}
