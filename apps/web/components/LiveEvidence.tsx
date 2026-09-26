"use client";

import { useArtifactUrl } from "../lib/artifacts";
import type { ScreenshotRef } from "../lib/progress-reducer";
import { Icon } from "./Icon";
import { formatTime } from "./format";

interface Props {
  runId: string;
  screenshot: ScreenshotRef | null;
}

/** The latest screenshot of the run, fetched through the proxy under the shared reveal rule. */
export function LiveEvidence({ runId, screenshot }: Props) {
  const { state, reveal, onLoadError } = useArtifactUrl(
    screenshot ? { runId, artifactId: screenshot.artifactId, sensitivity: screenshot.sensitivity } : null,
  );

  return (
    <section className="card evidence" aria-labelledby="evidence-title">
      <h2 id="evidence-title" className="card-title">
        Latest screenshot
      </h2>
      {!screenshot ? (
        <div className="evidence-empty">
          <Icon name="image" />
          <p>No screenshot yet. Screenshots appear here as the run captures checkpoints.</p>
        </div>
      ) : state.status === "reveal-required" ? (
        <div className="evidence-empty">
          <Icon name="lock" />
          <p>This screenshot may show entered credentials, so it is hidden until you ask for it.</p>
          <button type="button" className="button button-secondary" onClick={reveal}>
            Reveal screenshot
          </button>
        </div>
      ) : state.status === "ready" ? (
        <figure className="evidence-figure">
          {/* Short-lived signed URL: an error means it expired, so fetch a fresh one. */}
          <img src={state.url} alt={screenshot.message} onError={onLoadError} />
          <figcaption>
            {screenshot.message} · <time dateTime={screenshot.timestamp}>{formatTime(screenshot.timestamp)}</time>
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
