import { PROGRESS_STAGES, STAGE_LABELS, type ProgressState, type StageState } from "../lib/progress-reducer";
import { Icon, type IconName } from "./Icon";

const STATE: Record<StageState, { icon: IconName; label: string }> = {
  done: { icon: "check", label: "Done" },
  current: { icon: "current", label: "In progress" },
  pending: { icon: "pending", label: "Pending" },
  skipped: { icon: "skip", label: "Skipped" },
  stopped: { icon: "stop", label: "Stopped" },
};

/** Stage list (done / current / skipped / stopped) and an overall progress bar. */
export function RunProgress({ progress }: { progress: ProgressState }) {
  const { stages, currentStage, percent, outcome } = progress;
  const now = outcome ? null : currentStage ? STAGE_LABELS[currentStage] : null;
  return (
    <section className="card" aria-labelledby="progress-title">
      <h2 id="progress-title" className="card-title">
        Progress
      </h2>
      <div className="progress-line">
        <div
          className="progress"
          role="progressbar"
          aria-label="Run progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <div className="progress-fill" style={{ width: `${percent}%` }} />
        </div>
        <span className="progress-value">{percent}%</span>
      </div>
      <p className="muted" role="status" aria-live="polite">
        {now ? `Now: ${now}` : outcome ? (outcome.kind === "completed" ? "Finished" : "Stopped") : "Waiting for the next stage…"}
      </p>
      <ol className="stages" aria-label="Stages">
        {PROGRESS_STAGES.map((stage) => {
          const s = STATE[stages[stage]];
          return (
            <li key={stage} className={`stage stage-${stages[stage]}`} aria-current={stages[stage] === "current" ? "step" : undefined}>
              <Icon name={s.icon} />
              <span className="stage-label">{STAGE_LABELS[stage]}</span>
              <span className="stage-state">{s.label}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
