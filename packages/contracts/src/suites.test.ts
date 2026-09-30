import { describe, expect, it } from "vitest";
import type { RunLifecycle, RunVerdict } from "./run";
import { RunSuiteRequestSchema, SuiteInputSchema, suiteRunCounts, suiteVerdict } from "./suites";

const done = (verdict: RunVerdict) => ({ lifecycle: "COMPLETED" as RunLifecycle, verdict });
const ended = (lifecycle: RunLifecycle) => ({ lifecycle, verdict: null });

describe("suiteVerdict", () => {
  it("is null while a child is still running", () => {
    expect(suiteVerdict([done("FAILED"), ended("RUNNING_PLAYWRIGHT")])).toBeNull();
    expect(suiteVerdict([ended("QUEUED")])).toBeNull();
  });

  it("FAILED beats BLOCKED beats INCONCLUSIVE (errored and cancelled count as inconclusive) beats PASSED", () => {
    expect(suiteVerdict([done("PASSED"), done("BLOCKED"), done("FAILED"), ended("ERRORED")])).toBe("FAILED");
    expect(suiteVerdict([done("PASSED"), done("INCONCLUSIVE"), done("BLOCKED")])).toBe("BLOCKED");
    expect(suiteVerdict([done("PASSED"), ended("ERRORED")])).toBe("INCONCLUSIVE");
    expect(suiteVerdict([done("PASSED"), ended("CANCELLED")])).toBe("INCONCLUSIVE");
    expect(suiteVerdict([done("PASSED"), done("INCONCLUSIVE")])).toBe("INCONCLUSIVE");
    expect(suiteVerdict([done("PASSED"), done("PASSED")])).toBe("PASSED");
  });
});

describe("suiteRunCounts", () => {
  it("counts each child once", () => {
    expect(
      suiteRunCounts([done("PASSED"), done("FAILED"), done("BLOCKED"), done("INCONCLUSIVE"), ended("ERRORED"), ended("QUEUED")]),
    ).toEqual({ total: 6, active: 1, passed: 1, failed: 1, blocked: 1, inconclusive: 1, noVerdict: 1 });
  });
});

describe("suite requests", () => {
  it("trims names and defaults the description and saved credentials", () => {
    expect(SuiteInputSchema.parse({ name: "  Smoke " })).toEqual({ name: "Smoke", description: "", credentialProfileId: null });
    expect(SuiteInputSchema.safeParse({ name: " " }).success).toBe(false);
  });

  it("validates a run's secrets like a test run's", () => {
    expect(RunSuiteRequestSchema.parse({})).toEqual({ secrets: {} });
    expect(RunSuiteRequestSchema.safeParse({ secrets: { "Bad Name": "x" } }).success).toBe(false);
  });
});
