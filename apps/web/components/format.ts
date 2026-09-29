import type { CancelReason, ErrorCategory, RunLifecycle, RunVerdict } from "@platform/contracts";

/** Local wall-clock time (HH:MM:SS). */
export const formatTime = (iso: string): string =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export const LIFECYCLE_LABEL: Record<RunLifecycle, string> = {
  QUEUED: "Queued",
  SURVEYING: "Exploring for test ideas",
  AWAITING_SELECTION: "Awaiting your choice",
  ANALYZING_REQUIREMENT: "Analyzing",
  AWAITING_CONFIRMATION: "Awaiting confirmation",
  PLANNING: "Planning",
  EXPLORING: "Exploring",
  VERIFYING: "Verifying",
  GENERATING_TEST: "Generating test",
  RUNNING_PLAYWRIGHT: "Rerunning test",
  GENERATING_REPORT: "Generating report",
  COMPLETED: "Completed",
  ERRORED: "Errored",
  CANCELLED: "Cancelled",
};

export const VERDICT_LABEL: Record<RunVerdict, string> = {
  PASSED: "Passed",
  FAILED: "Failed",
  BLOCKED: "Blocked",
  INCONCLUSIVE: "Inconclusive",
};

export const ERROR_CATEGORY_LABEL: Record<ErrorCategory, string> = {
  MODEL_PROVIDER: "Model provider error",
  BROWSER_PROVIDER: "Browser error",
  TIMEOUT: "Time limit reached",
  STORAGE: "Storage error",
  CONTRACT: "Unexpected data from a stage",
  WORKER_LOST: "Worker stopped responding",
  INTERNAL: "Internal error",
};

export const CANCEL_REASON_TEXT: Record<CancelReason, string> = {
  USER_REQUESTED: "The run was cancelled at your request.",
  CONFIRMATION_EXPIRED: "The criteria weren't confirmed in time, so the run was cancelled.",
  SELECTION_EXPIRED: "No suggested test was chosen in time, so the run was cancelled.",
};
