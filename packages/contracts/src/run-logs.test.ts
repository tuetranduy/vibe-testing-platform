import { describe, expect, it } from "vitest";
import { ClientLogBatchSchema, RunLogQuerySchema, RunLogSourceSchema } from "./run-logs";

const line = (message = "boom") => ({
  time: "2026-11-25T10:00:00.000Z",
  level: "error" as const,
  message,
  url: "https://app.example/runs/r1",
  kind: "error" as const,
});

describe("run log contracts", () => {
  it("lists the seven sources in order", () => {
    expect(RunLogSourceSchema.options).toEqual(["worker", "api", "runner", "browser_use", "infra", "web_app", "target_site"]);
  });

  it("splits a comma-separated source filter", () => {
    expect(RunLogQuerySchema.parse({ source: "worker,infra" }).source).toEqual(["worker", "infra"]);
  });

  it("defaults limit to 500 and rejects 1001", () => {
    expect(RunLogQuerySchema.parse({}).limit).toBe(500);
    expect(RunLogQuerySchema.parse({ limit: "20" }).limit).toBe(20);
    expect(RunLogQuerySchema.safeParse({ limit: "1001" }).success).toBe(false);
  });

  it("rejects an unknown source", () => {
    expect(RunLogQuerySchema.safeParse({ source: "worker,disk" }).success).toBe(false);
  });

  it("caps a client batch at 50 lines and 4096-char messages", () => {
    expect(ClientLogBatchSchema.safeParse({ lines: Array.from({ length: 50 }, () => line()) }).success).toBe(true);
    expect(ClientLogBatchSchema.safeParse({ lines: Array.from({ length: 51 }, () => line()) }).success).toBe(false);
    expect(ClientLogBatchSchema.safeParse({ lines: [line("x".repeat(4097))] }).success).toBe(false);
    expect(ClientLogBatchSchema.safeParse({ lines: [] }).success).toBe(false);
  });
});
