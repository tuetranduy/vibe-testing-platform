import { RunLifecycleSchema, type RunLifecycle } from "@platform/contracts";
import { describe, expect, it } from "vitest";
import { IllegalRunTransitionError } from "./errors";
import { ACTIVE_LIFECYCLES, NON_TERMINAL_LIFECYCLES, TERMINAL_LIFECYCLES, assertTransition, isLegalTransition } from "./state-machine";

// Section 2.1, plus the survey's edges (spec 2026-09-28-suggest-tests).
const LEGAL: [RunLifecycle, RunLifecycle][] = [
  ["QUEUED", "SURVEYING"],
  ["SURVEYING", "AWAITING_SELECTION"],
  ["AWAITING_SELECTION", "ANALYZING_REQUIREMENT"],
  ["QUEUED", "ANALYZING_REQUIREMENT"],
  ["QUEUED", "RUNNING_PLAYWRIGHT"], // a manual rerun (V1.1 F5)
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

describe("run state machine", () => {
  it.each(LEGAL)("allows %s → %s", (from, to) => {
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  it.each([
    ["QUEUED", "VERIFYING"],
    ["COMPLETED", "CANCELLED"],
    ["AWAITING_CONFIRMATION", "EXPLORING"],
    ["QUEUED", "COMPLETED"],
    ["EXPLORING", "PLANNING"],
    ["VERIFYING", "RUNNING_PLAYWRIGHT"],
    ["QUEUED", "QUEUED"],
    ["QUEUED", "AWAITING_SELECTION"],
    ["SURVEYING", "ANALYZING_REQUIREMENT"],
    ["SURVEYING", "AWAITING_CONFIRMATION"],
    ["AWAITING_SELECTION", "SURVEYING"],
    ["AWAITING_SELECTION", "PLANNING"],
    ["ANALYZING_REQUIREMENT", "AWAITING_SELECTION"],
  ] as [RunLifecycle, RunLifecycle][])("rejects %s → %s", (from, to) => {
    expect(() => assertTransition(from, to)).toThrow(IllegalRunTransitionError);
  });

  it.each(NON_TERMINAL_LIFECYCLES.map((l) => [l]))("%s can be cancelled and errored", (from) => {
    expect(isLegalTransition(from, "CANCELLED")).toBe(true);
    expect(isLegalTransition(from, "ERRORED")).toBe(true);
  });

  it.each(TERMINAL_LIFECYCLES.map((l) => [l]))("terminal %s goes nowhere", (from) => {
    for (const to of RunLifecycleSchema.options) expect(isLegalTransition(from, to)).toBe(false);
  });

  it("a worker holds SURVEYING (heartbeat); nobody holds AWAITING_SELECTION, which is still not terminal", () => {
    expect(ACTIVE_LIFECYCLES).toContain("SURVEYING");
    expect(ACTIVE_LIFECYCLES).not.toContain("AWAITING_SELECTION");
    expect(NON_TERMINAL_LIFECYCLES).toContain("AWAITING_SELECTION");
  });

  it("allows exactly the table plus cancel/error edges", () => {
    let count = 0;
    for (const from of RunLifecycleSchema.options)
      for (const to of RunLifecycleSchema.options) if (isLegalTransition(from, to)) count++;
    expect(count).toBe(LEGAL.length + NON_TERMINAL_LIFECYCLES.length * 2);
    expect(NON_TERMINAL_LIFECYCLES.length + TERMINAL_LIFECYCLES.length).toBe(RunLifecycleSchema.options.length);
  });
});
