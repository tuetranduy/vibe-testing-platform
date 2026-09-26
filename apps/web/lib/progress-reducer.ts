import {
  RunLifecycleSchema,
  type ArtifactSensitivity,
  type ArtifactType,
  type CancelReason,
  type ExplorationStep,
  type ErrorCategory,
  type RunLifecycle,
  type RunVerdict,
  type TestEvent,
} from "@platform/contracts";

/** The stages a run moves through, in order (terminal lifecycles are outcomes, not stages). */
export const PROGRESS_STAGES = [
  "ANALYZING_REQUIREMENT",
  "AWAITING_CONFIRMATION",
  "PLANNING",
  "EXPLORING",
  "VERIFYING",
  "GENERATING_TEST",
  "RUNNING_PLAYWRIGHT",
  "GENERATING_REPORT",
] as const satisfies readonly RunLifecycle[];
export type ProgressStage = (typeof PROGRESS_STAGES)[number];

export const STAGE_LABELS: Record<ProgressStage, string> = {
  ANALYZING_REQUIREMENT: "Analyzing requirement",
  AWAITING_CONFIRMATION: "Confirming criteria",
  PLANNING: "Planning test",
  EXPLORING: "Exploring website",
  VERIFYING: "Verifying criteria",
  GENERATING_TEST: "Generating Playwright test",
  RUNNING_PLAYWRIGHT: "Rerunning generated test",
  GENERATING_REPORT: "Generating report",
};

/**
 * Share of the progress bar each stage is worth (sums to 100). Roughly the time each stage takes:
 * exploration gets the largest share (its budget is up to 60 % of the run), the Playwright rerun the
 * next (up to 25 %); confirmation is a user gate and is worth nothing. A skipped stage's weight is
 * dropped from the total, so the remaining stages fill the bar.
 */
export const STAGE_WEIGHTS: Record<ProgressStage, number> = {
  ANALYZING_REQUIREMENT: 10,
  AWAITING_CONFIRMATION: 0,
  PLANNING: 10,
  EXPLORING: 45,
  VERIFYING: 5,
  GENERATING_TEST: 10,
  RUNNING_PLAYWRIGHT: 15,
  GENERATING_REPORT: 5,
};

/** Exploration is credited by recorded steps against the plan, but never fully until it completes. */
const MAX_PARTIAL_CREDIT = 0.9;

export type StageState = "pending" | "current" | "done" | "skipped" | "stopped";
export type Tone = "info" | "success" | "warning" | "error";

export interface TimelineItem {
  sequence: number;
  timestamp: string;
  type: TestEvent["type"];
  /** Template-built server text — never model output. */
  message: string;
  tone: Tone;
  /** Criterion id ("AC-2") or step ("Step 3") the event is about. */
  reference: string | null;
}

export type RunOutcome =
  | { kind: "completed"; verdict: RunVerdict }
  | { kind: "cancelled"; reason: CancelReason; message: string }
  | { kind: "errored"; category: ErrorCategory; message: string };

export interface ScreenshotRef {
  artifactId: string;
  sensitivity: ArtifactSensitivity;
  message: string;
  timestamp: string;
}

/** An artifact of the run, as announced by its `artifact.created` event (the report only has ids). */
export interface ArtifactInfo {
  artifactId: string;
  type: ArtifactType;
  sensitivity: ArtifactSensitivity;
  /** Template-built server text, e.g. "Screenshot saved at checkpoint after_add". */
  message: string;
  timestamp: string;
}

/** An exploration step, as announced by its `step.recorded` event. */
export interface StepInfo {
  stepId: string;
  index: number;
  kind: ExplorationStep["kind"];
  outcome: ExplorationStep["outcome"];
  /** Template-built server text, e.g. "Step 3: fill succeeded". */
  message: string;
}

export interface ProgressState {
  latestSequence: number;
  stages: Record<ProgressStage, StageState>;
  currentStage: ProgressStage | null;
  percent: number;
  /** Furthest lifecycle stamped on any event (events carry the lifecycle at publish time). */
  latestStage: RunLifecycle | null;
  criteriaConfirmed: boolean;
  plannedSteps: number | null;
  stepsRecorded: number;
  latestScreenshot: ScreenshotRef | null;
  /** Every artifact and step announced so far, in event order. */
  artifacts: ArtifactInfo[];
  steps: StepInfo[];
  timeline: TimelineItem[];
  outcome: RunOutcome | null;
}

const isProgressStage = (s: RunLifecycle): s is ProgressStage => (PROGRESS_STAGES as readonly string[]).includes(s);
export const lifecycleRank = (l: RunLifecycle): number => RunLifecycleSchema.options.indexOf(l);

export function initialProgress(): ProgressState {
  return {
    latestSequence: 0,
    stages: Object.fromEntries(PROGRESS_STAGES.map((s) => [s, "pending"])) as Record<ProgressStage, StageState>,
    currentStage: null,
    percent: 0,
    latestStage: null,
    criteriaConfirmed: false,
    plannedSteps: null,
    stepsRecorded: 0,
    latestScreenshot: null,
    artifacts: [],
    steps: [],
    timeline: [],
    outcome: null,
  };
}

function percentOf(s: ProgressState): number {
  if (s.outcome?.kind === "completed") return 100;
  let total = 0;
  let done = 0;
  for (const stage of PROGRESS_STAGES) {
    const w = STAGE_WEIGHTS[stage];
    const state = s.stages[stage];
    if (state === "skipped") continue;
    total += w;
    if (state === "done") done += w;
    else if (state === "current" && stage === "EXPLORING" && s.plannedSteps) {
      done += w * Math.min(s.stepsRecorded / s.plannedSteps, MAX_PARTIAL_CREDIT);
    }
  }
  return total === 0 ? 0 : Math.round((done / total) * 100);
}

function tone(e: TestEvent): Tone {
  switch (e.type) {
    case "stage.completed":
    case "criteria.confirmed":
    case "test.generated":
      return "success";
    case "step.recorded":
      return e.payload.outcome === "SUCCESS" ? "success" : "warning";
    case "criterion.evaluated":
      return e.payload.status === "PASS" ? "success" : e.payload.status === "FAIL" ? "error" : "warning";
    case "playwright.completed":
      return e.payload.status === "PASSED" ? "success" : e.payload.status === "FAILED" ? "error" : "warning";
    case "run.completed":
      return e.payload.verdict === "PASSED" ? "success" : e.payload.verdict === "FAILED" ? "error" : "warning";
    case "artifact.omitted":
    case "egress.blocked":
    case "stage.skipped":
    case "run.cancelled":
      return "warning";
    case "run.errored":
      return "error";
    default:
      return "info";
  }
}

function reference(e: TestEvent): string | null {
  switch (e.type) {
    case "criterion.evaluated":
      return e.payload.criterionId;
    case "step.recorded":
      return `Step ${e.payload.index + 1}`;
    default:
      return null;
  }
}

/** Marks every still-pending stage before `stage` done (a later stage has started, so they finished). */
function settleBefore(stages: Record<ProgressStage, StageState>, stage: ProgressStage) {
  for (const s of PROGRESS_STAGES) {
    if (s === stage) return;
    if (stages[s] === "pending" || stages[s] === "current") stages[s] = "done";
  }
}

/**
 * Pure: folds one event into the progress state. Events must arrive in sequence order; a duplicate
 * or out-of-order event (sequence ≤ the latest seen) returns the state unchanged.
 */
export function progressReducer(state: ProgressState, e: TestEvent): ProgressState {
  if (e.sequence <= state.latestSequence || state.outcome) return state;
  const stages = { ...state.stages };
  let currentStage = state.currentStage;
  const next: ProgressState = {
    ...state,
    latestSequence: e.sequence,
    latestStage: state.latestStage === null || lifecycleRank(e.stage) > lifecycleRank(state.latestStage) ? e.stage : state.latestStage,
    timeline: [
      ...state.timeline,
      { sequence: e.sequence, timestamp: e.timestamp, type: e.type, message: e.message, tone: tone(e), reference: reference(e) },
    ],
  };

  switch (e.type) {
    case "stage.started": {
      const s = e.payload.stage;
      if (!isProgressStage(s)) break;
      settleBefore(stages, s);
      stages[s] = "current";
      currentStage = s;
      break;
    }
    case "stage.completed": {
      const s = e.payload.stage;
      if (!isProgressStage(s)) break;
      settleBefore(stages, s);
      stages[s] = "done";
      if (currentStage === s) currentStage = null;
      break;
    }
    case "stage.skipped": {
      const s = e.payload.stage;
      if (!isProgressStage(s)) break;
      stages[s] = "skipped";
      if (currentStage === s) currentStage = null;
      break;
    }
    case "criteria.confirmed":
      settleBefore(stages, "AWAITING_CONFIRMATION");
      stages.AWAITING_CONFIRMATION = "done";
      next.criteriaConfirmed = true;
      break;
    case "plan.created":
      next.plannedSteps = e.payload.stepCount;
      break;
    case "step.recorded": {
      const { stepId, index, kind, outcome } = e.payload;
      next.stepsRecorded = state.stepsRecorded + 1;
      next.steps = [...state.steps, { stepId, index, kind, outcome, message: e.message }];
      break;
    }
    case "artifact.created":
      next.artifacts = [
        ...state.artifacts,
        { artifactId: e.payload.artifactId, type: e.payload.type, sensitivity: e.payload.sensitivity, message: e.message, timestamp: e.timestamp },
      ];
      if (e.payload.type === "SCREENSHOT") {
        next.latestScreenshot = {
          artifactId: e.payload.artifactId,
          sensitivity: e.payload.sensitivity,
          message: e.message,
          timestamp: e.timestamp,
        };
      }
      break;
    case "run.completed":
      for (const s of PROGRESS_STAGES) if (stages[s] !== "skipped") stages[s] = "done";
      currentStage = null;
      next.outcome = { kind: "completed", verdict: e.payload.verdict };
      break;
    case "run.cancelled":
    case "run.errored":
      if (currentStage) stages[currentStage] = "stopped";
      currentStage = null;
      next.outcome =
        e.type === "run.cancelled"
          ? { kind: "cancelled", reason: e.payload.reason, message: e.message }
          : { kind: "errored", category: e.payload.category, message: e.message };
      break;
    default:
      break;
  }

  next.stages = stages;
  next.currentStage = currentStage;
  next.percent = percentOf(next);
  return next;
}
