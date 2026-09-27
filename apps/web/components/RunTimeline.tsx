import type { TimelineItem, Tone } from "../lib/progress-reducer";
import { Icon, type IconName } from "./Icon";
import { formatTime } from "./format";

/** A marker per tone (a plain dot for information); the tone's word is there for assistive tech. */
const TONE: Record<Tone, { icon: IconName | null; label: string | null }> = {
  info: { icon: null, label: null },
  success: { icon: "check", label: "Success" },
  warning: { icon: "warning", label: "Warning" },
  error: { icon: "x", label: "Problem" },
};

/** Newest first. Only the server's template messages and ids are shown — never model output. */
export function RunTimeline({ items }: { items: TimelineItem[] }) {
  return (
    <section className="card timeline-card" aria-labelledby="timeline-title">
      <div className="timeline-card-head">
        <h2 id="timeline-title" className="card-title">
          Timeline
        </h2>
        {items.length > 0 && <span className="hint">Newest first</span>}
      </div>
      {items.length === 0 ? (
        <p className="muted">Waiting for the first update…</p>
      ) : (
        <ol className="timeline" aria-label="Timeline" tabIndex={0}>
          {[...items].reverse().map((item) => {
            const tone = TONE[item.tone];
            return (
              <li key={item.sequence} className={`timeline-item tone-${item.tone}`}>
                <span className="timeline-marker" aria-hidden="true">
                  {tone.icon ? <Icon name={tone.icon} /> : <span className="timeline-dot" />}
                </span>
                <span className="timeline-body">
                  <span className="timeline-message">
                    {tone.label && <span className="visually-hidden">{tone.label}: </span>}
                    {item.message}
                  </span>
                  {item.reference && <span className="ref">{item.reference}</span>}
                </span>
                <time dateTime={item.timestamp}>{formatTime(item.timestamp)}</time>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
