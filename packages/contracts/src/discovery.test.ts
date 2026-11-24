import { describe, expect, it } from "vitest";
import { DiscoveryInputSchema, DiscoveryResultSchema, DiscoverySummarySchema } from "./discovery";

const base = { schemaVersion: "discovery.v1", runId: "run_1" } as const;

describe("discovery.v1 contracts", () => {
  it("bounds a broker job's whole budget at 10–120 seconds", () => {
    const input = { ...base, targetUrl: "http://127.0.0.1:4599/" };
    expect(DiscoveryInputSchema.parse({ ...input, timeoutSeconds: 10 }).timeoutSeconds).toBe(10);
    expect(DiscoveryInputSchema.safeParse({ ...input, timeoutSeconds: 9 }).success).toBe(false);
    expect(DiscoveryInputSchema.safeParse({ ...input, timeoutSeconds: 121 }).success).toBe(false);
  });

  it("accepts the broker's reason codes and violation count, and nothing that is not a code", () => {
    const statistics = { agentSteps: 2, modelRequests: 2, durationMs: 1000, inputTokens: 1, outputTokens: 1, modelCostUsd: null, protocolViolations: 0, peakMemoryBytes: 512 * 1024 ** 2 };
    expect(DiscoveryResultSchema.parse({ ...base, status: "PARTIAL", reason: "timeout", candidates: [], statistics }).reason).toBe("timeout");
    expect(DiscoveryResultSchema.parse({ ...base, status: "FAILED", candidates: [] }).reason).toBeUndefined();
    expect(DiscoveryResultSchema.parse({ ...base, status: "FAILED", candidates: [], statistics: { ...statistics, peakMemoryBytes: null } })
      .statistics?.peakMemoryBytes).toBeNull();
    expect(DiscoveryResultSchema.safeParse({ ...base, status: "FAILED", candidates: [], statistics: { ...statistics, peakMemoryBytes: -1 } }).success).toBe(false);
    expect(DiscoveryResultSchema.safeParse({ ...base, status: "FAILED", reason: "page said hello", candidates: [] }).success).toBe(false);
  });

  it("records platform outcomes (timed out, busy) separately from broker statuses, and parses older summaries", () => {
    const summary = { candidateCount: 0, acceptedCount: 0, pageCount: 0, fallbackUsed: true };
    expect(DiscoverySummarySchema.parse({ ...summary, status: "BUSY", reason: "broker_busy", attempted: false }).status).toBe("BUSY");
    expect(DiscoverySummarySchema.parse({ ...summary, status: "TIMED_OUT", reason: "worker_deadline", attempted: true }).status).toBe("TIMED_OUT");
    expect(DiscoverySummarySchema.parse({ ...summary, status: "FAILED" })).toEqual({ ...summary, status: "FAILED" });
    expect(DiscoverySummarySchema.safeParse({ ...summary, status: "BUSY", reason: "free text" }).success).toBe(false);
  });
});
