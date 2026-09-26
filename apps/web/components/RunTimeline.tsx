import type { TimelineItem, Tone } from "../lib/progress-reducer";
import { Icon, type IconName } from "./Icon";
import { formatTime } from "./format";

const TONE: Record<Tone, { icon: IconName; label: string | null }> = {
  info: { icon: "info", label: null },
  success: { icon: "check", label: "Success" },
  warning: { icon: "warning", label: "Warning" },
  error: { icon: "error", label: "Problem" },
};

/** Newest first. Only the server's template messages and ids are shown — never model output. */
export function RunTimeline({ items }: { items: TimelineItem[] }) {
  return (
    <section className="card" aria-labelledby="timeline-title">
      <h2 id="timeline-title" className="card-title">
        Timeline
      </h2>
      {items.length === 0 ? (
        <p className="muted">Waiting for the first update…</p>
      ) : (
        <ol className="timeline" aria-label="Timeline" tabIndex={0}>
          {[...items].reverse().map((item) => {
            const tone = TONE[item.tone];
            return (
              <li key={item.sequence} className={`timeline-item tone-${item.tone}`}>
                <Icon name={tone.icon} />
                <time dateTime={item.timestamp}>{formatTime(item.timestamp)}</time>
                <span className="timeline-message">
                  {tone.label && <span className="visually-hidden">{tone.label}: </span>}
                  {item.message}
                </span>
                {item.reference && <span className="ref">{item.reference}</span>}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
