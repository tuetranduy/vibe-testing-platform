import { TERMINAL_LIFECYCLES, isTerminalLifecycle, type RunLifecycle } from "@platform/contracts";
import { IllegalRunTransitionError } from "./errors";

/** Section 2.1 — explicit edges. CANCELLED / ERRORED from any non-terminal state are added below. */
const EDGES: ReadonlyArray<readonly [RunLifecycle, RunLifecycle]> = [
  // A blank requirement: survey the website, wait for the user's choice, then analyse it
  // (spec 2026-09-28-suggest-tests).
  ["QUEUED", "SURVEYING"],
  ["SURVEYING", "AWAITING_SELECTION"],
  ["AWAITING_SELECTION", "ANALYZING_REQUIREMENT"],
  ["QUEUED", "ANALYZING_REQUIREMENT"],
  ["ANALYZING_REQUIREMENT", "AWAITING_CONFIRMATION"],
  ["ANALYZING_REQUIREMENT", "PLANNING"],
  ["AWAITING_CONFIRMATION", "PLANNING"],
  ["PLANNING", "EXPLORING"],
  ["PLANNING", "GENERATING_REPORT"],
  ["EXPLORING", "VERIFYING"],
  ["VERIFYING", "GENERATING_TEST"],
  ["VERIFYING", "GENERATING_REPORT"],
  ["GENERATING_TEST", "RUNNING_PLAYWRIGHT"],
  ["GENERATING_TEST", "GENERATING_REPORT"],
  ["RUNNING_PLAYWRIGHT", "GENERATING_REPORT"],
  ["GENERATING_REPORT", "COMPLETED"],
];

export const TRANSITION_TABLE: ReadonlyArray<readonly [RunLifecycle, RunLifecycle]> = EDGES;

export function isLegalTransition(from: RunLifecycle, to: RunLifecycle): boolean {
  if (isTerminalLifecycle(from)) return false;
  if (to === "CANCELLED" || to === "ERRORED") return true;
  return EDGES.some(([f, t]) => f === from && t === to);
}

export function assertTransition(from: RunLifecycle, to: RunLifecycle): void {
  if (!isLegalTransition(from, to)) throw new IllegalRunTransitionError(from, to);
}

/** Lifecycles in which a worker is (or should be) actively processing the run. */
export const ACTIVE_LIFECYCLES: readonly RunLifecycle[] = [
  "SURVEYING",
  "ANALYZING_REQUIREMENT",
  "PLANNING",
  "EXPLORING",
  "VERIFYING",
  "GENERATING_TEST",
  "RUNNING_PLAYWRIGHT",
  "GENERATING_REPORT",
];

/** Non-terminal; the waiting ones (QUEUED, AWAITING_*) are held by no worker. */
export const NON_TERMINAL_LIFECYCLES: readonly RunLifecycle[] = [
  "QUEUED",
  "AWAITING_SELECTION",
  "AWAITING_CONFIRMATION",
  ...ACTIVE_LIFECYCLES,
];

export { TERMINAL_LIFECYCLES, isTerminalLifecycle };
