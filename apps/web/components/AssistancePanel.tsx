"use client";

import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { useEffect, useState } from "react";
import { answerAssistance } from "../lib/api";
import { useArtifactUrl } from "../lib/artifacts";
import type { ProgressState } from "../lib/progress-reducer";

/**
 * Keep the question until the worker answers it, including an answer from another tab (2026-11-21). The reducer
 * restores it from events on reload; image URLs use the same bounded refresh path as the rest of the run's evidence.
 */
export function AssistancePanel({ runId, request }: { runId: string; request: NonNullable<ProgressState["assistance"]> }) {
  const { state: image, onLoadError } = useArtifactUrl({ runId, artifactId: request.screenshotArtifactId });
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.ceil((Date.parse(request.expiresAt) - now) / 1000));

  async function answer(body: { instruction: string } | { stop: true }) {
    setPending(true);
    setError(null);
    try {
      await answerAssistance(runId, request.requestId, body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The answer could not be sent");
      setPending(false);
    }
  }

  return (
    <Card as="section" className="flex min-w-0 flex-col gap-5" aria-labelledby="assistance-title">
      <h2 id="assistance-title">The test is stuck — tell it what to do next</h2>
      <p style={{ overflowWrap: "anywhere" }}>{request.question}</p>
      <p style={{ overflowWrap: "anywhere" }}>Current URL: {request.url}</p>
      <p role="status">{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")} left to answer</p>
      {image.status === "ready" ? (
        <img src={image.url} alt="The current page where the test is stuck" onError={onLoadError} style={{ width: "100%", height: "auto" }} />
      ) : (
        <p role="status">{image.status === "error" ? image.message : "Loading screenshot…"}</p>
      )}
      <label htmlFor="assistance-instruction">What should the test do next?</label>
      <Textarea
        id="assistance-instruction"
        rows={4}
        maxLength={2000}
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={pending || seconds === 0}
        style={{ width: "100%", boxSizing: "border-box" }}
      />
      {error && <p role="alert">{error}</p>}
      <div className="actions flex flex-wrap items-center gap-2">
        <Button type="button" disabled={pending || seconds === 0 || !text.trim()} onClick={() => void answer({ instruction: text.trim() })}>
          Continue with this instruction
        </Button>
        <Button variant="outline"  disabled={pending || seconds === 0} onClick={() => void answer({ stop: true })}>
          Stop here
        </Button>
      </div>
    </Card>
  );
}
