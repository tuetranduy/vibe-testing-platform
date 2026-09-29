import type { RunLifecycle } from "@platform/contracts";
import { STAGE_LABELS, runStages, stagesFor, type ProgressState, type StageState } from "../lib/progress-reducer";
import { Icon, type IconName } from "./Icon";

/** Each state has its own marker shape (filled check, ring, hollow, dashed, cross), so it never rests on color. */
const STATE: Record<StageState, { icon: IconName | null; label: string }> = {
  done: { icon: "check", label: "Done" },
  current: { icon: null, label: "In progress" },
  pending: { icon: null, label: "Pending" },
  skipped: { icon: "skip", label: "Skipped" },
  stopped: { icon: "x", label: "Stopped" },
};

interface Props {
  progress: ProgressState;
  /** The run's lifecycle, for a stage that has no event of its own (awaiting a selection or confirmation). */
  lifecycle?: RunLifecycle;
  /** The run has a blank requirement: it explores for test ideas first, before any event says so. */
  survey?: boolean;
}

/** The current stage, an overall progress bar, and the run's stages (done / current / skipped / stopped). */
export function RunProgress({ progress, lifecycle, survey = false }: Props) {
  const shown = lifecycle
    ? stagesFor(progress, lifecycle, survey)
    : { stages: progress.stages, currentStage: progress.currentStage, survey: progress.survey || survey };
  const { stages, currentStage } = shown;
  const { percent, outcome } = progress;
  const now = outcome ? null : currentStage ? STAGE_LABELS[currentStage] : null;
  return (
    <section className="card progress-card" aria-labelledby="progress-title">
      <h2 id="progress-title" className="visually-hidden">
        Progress
      </h2>
      <div className="progress-head">
        <p className="progress-now" role="status" aria-live="polite">
          {now ? (
            <>
              Now: <strong>{now}</strong>
            </>
          ) : outcome ? (
            outcome.kind === "completed" ? (
              "Finished"
            ) : (
              "Stopped"
            )
          ) : (
            "Waiting for the next stage…"
          )}
        </p>
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
      </div>
      <ol className="stages" aria-label="Stages">
        {runStages(shown.survey).map((stage) => {
          const state = stages[stage];
          const s = STATE[state];
          return (
            <li key={stage} className={`stage stage-${state}`} aria-current={state === "current" ? "step" : undefined}>
              <span className="stage-track" aria-hidden="true">
                <span className="stage-marker">{s.icon && <Icon name={s.icon} />}</span>
                <span className="stage-line" />
              </span>
              <span className="stage-label">{STAGE_LABELS[stage]}</span>
              <span className="stage-state">, {s.label}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
