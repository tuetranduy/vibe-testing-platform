// @vitest-environment node
import type { TestEvent } from "@platform/contracts";
import { describe, expect, it } from "vitest";
import { ev } from "../test/events";
import {
  PROGRESS_STAGES,
  STAGE_WEIGHTS,
  initialProgress,
  progressReducer,
  runStages,
  stagesFor,
  type ProgressState,
} from "./progress-reducer";

const reduce = (events: TestEvent[], from: ProgressState = initialProgress()) => events.reduce(progressReducer, from);

const upToExploring = [
  ev(1, "stage.completed", { stage: "ANALYZING_REQUIREMENT" }),
  ev(2, "criteria.confirmed", { revision: 1 }, { stage: "AWAITING_CONFIRMATION" }),
  ev(3, "stage.completed", { stage: "PLANNING" }),
  ev(4, "stage.started", { stage: "EXPLORING" }),
];

describe("progressReducer", () => {
  it("the test's stage weights add up to 100", () => {
    expect(PROGRESS_STAGES.reduce((sum, s) => sum + STAGE_WEIGHTS[s], 0)).toBe(100);
  });

  it("tracks the current stage and marks prior stages done", () => {
    const s = reduce(upToExploring);
    expect(s.currentStage).toBe("EXPLORING");
    expect(s.stages.ANALYZING_REQUIREMENT).toBe("done");
    expect(s.stages.AWAITING_CONFIRMATION).toBe("done");
    expect(s.stages.PLANNING).toBe("done");
    expect(s.stages.EXPLORING).toBe("current");
    expect(s.stages.VERIFYING).toBe("pending");
    expect(s.criteriaConfirmed).toBe(true);
    expect(s.latestSequence).toBe(4);
  });

  it("computes progress from stage weights", () => {
    const s = reduce(upToExploring);
    const done = STAGE_WEIGHTS.ANALYZING_REQUIREMENT + STAGE_WEIGHTS.AWAITING_CONFIRMATION + STAGE_WEIGHTS.PLANNING;
    expect(s.percent).toBe(Math.round(done));
  });

  it("credits the exploring stage by recorded steps against the plan (capped below the full weight)", () => {
    const s = reduce([
      ev(1, "stage.completed", { stage: "ANALYZING_REQUIREMENT" }),
      ev(2, "plan.created", { stepCount: 4, blockedCriteria: [] }),
      ev(3, "stage.completed", { stage: "PLANNING" }),
      ev(4, "stage.started", { stage: "EXPLORING" }),
      ev(5, "step.recorded", { stepId: "st_1", index: 0, kind: "navigate", outcome: "SUCCESS", blockReason: null }, { stage: "EXPLORING" }),
      ev(6, "step.recorded", { stepId: "st_2", index: 1, kind: "act", outcome: "SUCCESS", blockReason: null }, { stage: "EXPLORING" }),
    ]);
    const base = STAGE_WEIGHTS.ANALYZING_REQUIREMENT + STAGE_WEIGHTS.AWAITING_CONFIRMATION + STAGE_WEIGHTS.PLANNING;
    expect(s.percent).toBe(Math.round(base + STAGE_WEIGHTS.EXPLORING * 0.5));
  });

  it("shows skipped stages as skipped and redistributes their weight", () => {
    const s = reduce([
      ...upToExploring,
      ev(5, "stage.completed", { stage: "EXPLORING" }),
      ev(6, "stage.started", { stage: "VERIFYING" }),
      ev(7, "stage.completed", { stage: "VERIFYING" }),
      ev(8, "stage.skipped", { stage: "GENERATING_TEST" }),
      ev(9, "stage.skipped", { stage: "RUNNING_PLAYWRIGHT" }),
    ]);
    expect(s.stages.GENERATING_TEST).toBe("skipped");
    expect(s.stages.RUNNING_PLAYWRIGHT).toBe("skipped");
    const w = STAGE_WEIGHTS;
    const done = w.ANALYZING_REQUIREMENT + w.AWAITING_CONFIRMATION + w.PLANNING + w.EXPLORING + w.VERIFYING;
    const total = 100 - w.GENERATING_TEST - w.RUNNING_PLAYWRIGHT;
    expect(s.percent).toBe(Math.round((done / total) * 100));
    expect(s.percent).toBeGreaterThan(Math.round(done)); // redistributed, not just the done weight
  });

  it("ignores duplicate and out-of-order sequences", () => {
    const s = reduce(upToExploring);
    expect(progressReducer(s, upToExploring[3]!)).toBe(s); // duplicate
    const stale = ev(3, "stage.started", { stage: "VERIFYING" });
    expect(progressReducer(s, stale)).toBe(s); // out of order
    const replayed = reduce([...upToExploring, ...upToExploring]);
    expect(replayed.timeline).toHaveLength(4);
  });

  it("completes at 100% on run.completed", () => {
    const s = reduce([
      ...upToExploring,
      ev(5, "stage.completed", { stage: "EXPLORING" }),
      ev(6, "stage.skipped", { stage: "GENERATING_TEST" }),
      ev(7, "stage.started", { stage: "GENERATING_REPORT" }),
      ev(8, "stage.completed", { stage: "GENERATING_REPORT" }),
      ev(9, "run.completed", { verdict: "PASSED" }, { stage: "COMPLETED" }),
    ]);
    expect(s.percent).toBe(100);
    expect(s.outcome).toEqual({ kind: "completed", verdict: "PASSED" });
    expect(s.currentStage).toBeNull();
    expect(s.stages.GENERATING_TEST).toBe("skipped");
    expect(s.stages.VERIFYING).toBe("done");
  });

  it("marks the current stage stopped on cancel or error, keeping the template message", () => {
    const cancelled = progressReducer(
      reduce(upToExploring),
      ev(5, "run.cancelled", { reason: "USER_REQUESTED" }, { stage: "CANCELLED", message: "Run cancelled by user" }),
    );
    expect(cancelled.stages.EXPLORING).toBe("stopped");
    expect(cancelled.outcome).toEqual({ kind: "cancelled", reason: "USER_REQUESTED", message: "Run cancelled by user" });

    const errored = progressReducer(
      reduce(upToExploring),
      ev(5, "run.errored", { category: "BROWSER_PROVIDER", message: "raw internal detail" }, { stage: "ERRORED", message: "Browser failed" }),
    );
    expect(errored.stages.EXPLORING).toBe("stopped");
    expect(errored.outcome).toEqual({ kind: "errored", category: "BROWSER_PROVIDER", message: "Browser failed" });
  });

  it("keeps only template text and references in the timeline, never payload dumps", () => {
    const s = reduce([
      ev(1, "criterion.evaluated", { criterionId: "AC-2", status: "FAIL", reason: null, provisional: true }, { message: "AC-2 provisionally FAIL" }),
      ev(2, "step.recorded", { stepId: "st_1", index: 2, kind: "act", outcome: "FAILED", blockReason: null }, { message: "Step 3: click failed" }),
    ]);
    expect(s.timeline[0]).toEqual({
      sequence: 1,
      timestamp: expect.any(String),
      type: "criterion.evaluated",
      message: "AC-2 provisionally FAIL",
      tone: "error",
      reference: "AC-2",
    });
    expect(s.timeline[1]).toMatchObject({ reference: "Step 3", tone: "warning" });
    expect(Object.keys(s.timeline[1]!)).not.toContain("payload");
  });

  it("tracks the latest screenshot artifact", () => {
    const s = reduce([
      ev(1, "artifact.created", { artifactId: "art_1", type: "SCREENSHOT", sensitivity: "STANDARD" }),
      ev(2, "artifact.created", { artifactId: "art_2", type: "TRACE", sensitivity: "STANDARD" }),
      ev(3, "artifact.created", { artifactId: "art_3", type: "SCREENSHOT", sensitivity: "SECRET_BEARING" }, { message: "Screenshot saved at checkpoint after_add" }),
    ]);
    expect(s.latestScreenshot).toMatchObject({
      artifactId: "art_3",
      sensitivity: "SECRET_BEARING",
      message: "Screenshot saved at checkpoint after_add",
    });
  });

  it("records the latest lifecycle seen on an event", () => {
    const s = reduce([ev(1, "stage.started", { stage: "ANALYZING_REQUIREMENT" }), ev(2, "stage.started", { stage: "EXPLORING" })]);
    expect(s.latestStage).toBe("EXPLORING");
  });
  it("collects every artifact and recorded step, for the report's evidence and related steps", () => {
    const s = reduce([
      ...upToExploring,
      ev(5, "step.recorded", { stepId: "st_1", index: 0, kind: "navigate", outcome: "SUCCESS", blockReason: null }, { stage: "EXPLORING", message: "Step 1: navigate succeeded" }),
      ev(6, "artifact.created", { artifactId: "art_1", type: "SCREENSHOT", sensitivity: "STANDARD" }, { stage: "EXPLORING", message: "Screenshot saved at checkpoint a" }),
      ev(7, "step.recorded", { stepId: "st_2", index: 1, kind: "fill", outcome: "FAILED", blockReason: null }, { stage: "EXPLORING", message: "Step 2: fill failed" }),
      ev(8, "artifact.created", { artifactId: "art_2", type: "TRACE", sensitivity: "SECRET_BEARING" }, { stage: "RUNNING_PLAYWRIGHT", message: "Rerun trace stored" }),
    ]);
    expect(s.artifacts).toEqual([
      { artifactId: "art_1", type: "SCREENSHOT", sensitivity: "STANDARD", message: "Screenshot saved at checkpoint a", timestamp: expect.any(String) },
      { artifactId: "art_2", type: "TRACE", sensitivity: "SECRET_BEARING", message: "Rerun trace stored", timestamp: expect.any(String) },
    ]);
    expect(s.steps).toEqual([
      { stepId: "st_1", index: 0, kind: "navigate", outcome: "SUCCESS", message: "Step 1: navigate succeeded" },
      { stepId: "st_2", index: 1, kind: "fill", outcome: "FAILED", message: "Step 2: fill failed" },
    ]);
    expect(s.latestScreenshot?.artifactId).toBe("art_1"); // a trace is not a screenshot
  });
});

describe("executionStartedAt", () => {
  it("is when the first stage after confirmation started", () => {
    const s = reduce([
      ev(1, "stage.started", { stage: "ANALYZING_REQUIREMENT" }),
      ev(2, "stage.completed", { stage: "ANALYZING_REQUIREMENT" }),
      ev(3, "criteria.confirmed", { revision: 1 }, { stage: "AWAITING_CONFIRMATION" }),
      ev(4, "stage.started", { stage: "PLANNING" }),
      ev(5, "stage.completed", { stage: "PLANNING" }),
      ev(6, "stage.started", { stage: "EXPLORING" }),
    ]);
    expect(s.executionStartedAt).toBe(new Date(Date.UTC(2026, 8, 26, 10, 0, 4)).toISOString());
  });

  it("is unknown while the run is only being analyzed", () => {
    expect(reduce([ev(1, "stage.started", { stage: "ANALYZING_REQUIREMENT" })]).executionStartedAt).toBeNull();
  });
});

describe("stagesFor", () => {
  it("shows the lifecycle's stage as current when no event marked one (awaiting confirmation)", () => {
    const s = reduce([ev(1, "stage.started", { stage: "ANALYZING_REQUIREMENT" }), ev(2, "stage.completed", { stage: "ANALYZING_REQUIREMENT" })]);
    const shown = stagesFor(s, "AWAITING_CONFIRMATION");
    expect(shown.currentStage).toBe("AWAITING_CONFIRMATION");
    expect(shown.stages.AWAITING_CONFIRMATION).toBe("current");
    expect(shown.stages.ANALYZING_REQUIREMENT).toBe("done");
    expect(s.stages.AWAITING_CONFIRMATION).toBe("pending"); // the state itself is untouched
  });

  it("settles the stages before it when the page has not seen their events yet", () => {
    const shown = stagesFor(initialProgress(), "AWAITING_CONFIRMATION");
    expect(shown.stages.ANALYZING_REQUIREMENT).toBe("done");
    expect(shown.stages.PLANNING).toBe("pending");
  });

  it("keeps the events' view when a stage is current, the run ended, or the lifecycle is not a stage", () => {
    const exploring = reduce(upToExploring);
    expect(stagesFor(exploring, "PLANNING")).toEqual({ stages: exploring.stages, currentStage: "EXPLORING", survey: false });
    const ended = reduce([...upToExploring, ev(5, "run.cancelled", { reason: "USER_REQUESTED" }, { stage: "CANCELLED" })]);
    expect(stagesFor(ended, "CANCELLED").currentStage).toBeNull();
    expect(stagesFor(initialProgress(), "QUEUED").currentStage).toBeNull();
  });
});

describe("a run that explores for test ideas (a blank requirement)", () => {
  const surveyed = [
    ev(1, "stage.started", { stage: "SURVEYING" }),
    ev(2, "page.surveyed", { path: "/", title: "Home", status: "READ" }, { stage: "SURVEYING", message: "Loaded / — Home" }),
    ev(3, "page.surveyed", { path: "/account", title: "", status: "SKIPPED" }, { stage: "SURVEYING", message: "Skipped /account — blocked by policy" }),
    ev(4, "suggestions.proposed", { count: 1, suggestions: [{ id: "S-1", title: "Add to cart" }] }, { stage: "SURVEYING", message: "1 test suggested" }),
    ev(5, "stage.completed", { stage: "SURVEYING" }),
  ];

  it("shows the survey's stages first, and only for such a run", () => {
    const s = reduce(surveyed);
    expect(s.survey).toBe(true);
    expect(s.stages.SURVEYING).toBe("done");
    expect(runStages(true).slice(0, 3)).toEqual(["SURVEYING", "AWAITING_SELECTION", "ANALYZING_REQUIREMENT"]);
    expect(reduce(upToExploring).survey).toBe(false);
    expect(runStages(false)).toEqual(PROGRESS_STAGES);
  });

  it("puts the pages in the timeline: read ones as success, skipped ones as warnings", () => {
    const s = reduce(surveyed);
    expect(s.timeline.filter((t) => t.type === "page.surveyed").map((t) => [t.message, t.tone])).toEqual([
      ["Loaded / — Home", "success"],
      ["Skipped /account — blocked by policy", "warning"],
    ]);
  });

  it("a selection settles the survey's stages and remembers a test was chosen", () => {
    const s = reduce([
      ...surveyed,
      ev(6, "suggestion.selected", { suggestionId: "S-1", edited: false }, { stage: "AWAITING_SELECTION" }),
      ev(7, "stage.started", { stage: "ANALYZING_REQUIREMENT" }),
    ]);
    expect(s.suggestionSelected).toBe(true);
    expect(s.stages.AWAITING_SELECTION).toBe("done");
    expect(s.currentStage).toBe("ANALYZING_REQUIREMENT");
  });

  it("counts the survey in the progress bar only for such a run", () => {
    expect(reduce(surveyed).percent).toBe(Math.round((STAGE_WEIGHTS.SURVEYING / (100 + STAGE_WEIGHTS.SURVEYING)) * 100));
    const plain = reduce(upToExploring);
    expect(plain.percent).toBe(STAGE_WEIGHTS.ANALYZING_REQUIREMENT + STAGE_WEIGHTS.AWAITING_CONFIRMATION + STAGE_WEIGHTS.PLANNING);
    expect(plain.stages.SURVEYING).toBe("pending"); // never settled for a run with a requirement
  });

  it("stagesFor: AWAITING_SELECTION is current once the survey completed (it has no event of its own)", () => {
    const shown = stagesFor(reduce(surveyed), "AWAITING_SELECTION");
    expect(shown.survey).toBe(true);
    expect(shown.currentStage).toBe("AWAITING_SELECTION");
    expect(shown.stages.SURVEYING).toBe("done");
  });

  it("stagesFor: a QUEUED blank-requirement run surveys before any event says so", () => {
    expect(stagesFor(initialProgress(), "QUEUED", true).survey).toBe(true);
    expect(stagesFor(initialProgress(), "QUEUED").survey).toBe(false);
  });
});
