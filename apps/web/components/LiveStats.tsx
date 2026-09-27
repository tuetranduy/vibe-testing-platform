"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import type { ProgressState } from "../lib/progress-reducer";

/** "0:48", "12:05", "1:02:03". */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** A running run at a glance: steps against the plan, time since execution started, screenshots taken. */
export function LiveStats({ progress }: { progress: ProgressState }) {
  const screenshots = progress.artifacts.filter((a) => a.type === "SCREENSHOT").length;
  return (
    <div className="live-stats">
      <Stat label="Steps">
        {progress.stepsRecorded}
        {progress.plannedSteps !== null && <small> / {progress.plannedSteps}</small>}
      </Stat>
      <Stat label="Elapsed">
        <Elapsed since={progress.executionStartedAt} />
      </Stat>
      <Stat label="Screenshots">{screenshots}</Stat>
    </div>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id} className="card live-stat">
      <span id={id} className="live-stat-label">
        {label}
      </span>
      <span className="live-stat-value">{children}</span>
    </div>
  );
}

/** Its own component, so only it re-renders every second. */
function Elapsed({ since }: { since: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  if (!since) return <>—</>;
  return <>{formatElapsed(now - Date.parse(since))}</>;
}
