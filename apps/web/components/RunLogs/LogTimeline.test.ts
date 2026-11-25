import type { LlmCallView, RunLogLine } from "@platform/contracts";
import { describe, expect, it } from "vitest";
import { mergeTimeline } from "./LogTimeline";

const line = (seq: number, time = "2026-11-25T10:00:00.000Z"): RunLogLine => ({
  id: `log_${seq}`, seq, time, source: "worker", level: "info", stage: null, component: "worker", message: `m${seq}`, fields: {},
});

describe("mergeTimeline", () => {
  it("orders by time, and lines with the same time by the order they were stored in", () => {
    // A poll can deliver a line stored later before one stored earlier is in the list.
    const items = mergeTimeline([line(3), line(1), line(2), line(4, "2026-11-25T09:59:59.000Z")], []);
    expect(items.map((i) => (i.kind === "line" ? i.line.message : ""))).toEqual(["m4", "m1", "m2", "m3"]);
  });

  it("puts a model call among the lines by its time", () => {
    const call = { id: "llm_1", time: "2026-11-25T10:00:00.500Z" } as LlmCallView;
    const items = mergeTimeline([line(1), line(2, "2026-11-25T10:00:01.000Z")], [call]);
    expect(items.map((i) => i.kind)).toEqual(["line", "call", "line"]);
  });
});
