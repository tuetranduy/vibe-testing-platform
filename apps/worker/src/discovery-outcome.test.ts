import { RunOptionsSchema, type SuggestionSet } from "@platform/contracts";
import { Registry } from "prom-client";
import { describe, expect, it, vi } from "vitest";
import { recordSelectedDiscoveryOutcome } from "./discovery-outcome";
import { createWorkerMetrics } from "./metrics";

const suggestion = (id: string, discovery: boolean) => ({
  id, title: `Idea ${id}`, requirement: `A visitor can check idea ${id}.`, why: "Seen.", needs: { secrets: [], testData: [] },
  destructive: false, ...(discovery ? { discovery: { engine: "browser_use" as const, relevantPaths: ["/"] } } : {}),
});
const set = (selected: string, edited = false): SuggestionSet => ({
  pages: [], suggestions: [suggestion("S-1", false), suggestion("S-2", true)], selected: { suggestionId: selected, edited },
}) as SuggestionSet;
const run = (autonomousDiscovery: boolean) => ({ id: "run_1", request: { options: RunOptionsSchema.parse({ autonomousDiscovery }) } }) as never;
const logger = { warn: vi.fn() };

async function samples(registry: Registry) {
  return (await registry.getSingleMetric("discovery_selected_runs_total")?.get())?.values ?? [];
}

describe("the outcome of a run that executed a selected Browser Use suggestion", () => {
  it("counts it by lifecycle, verdict and edit, from the run's existing provenance", async () => {
    const registry = new Registry();
    const metrics = createWorkerMetrics(registry);
    await recordSelectedDiscoveryOutcome({ metrics, logger }, run(true), "COMPLETED", "FAILED", async () => set("S-2", true));
    await recordSelectedDiscoveryOutcome({ metrics, logger }, run(true), "ERRORED", null, async () => set("S-2"));
    expect(await samples(registry)).toEqual([
      expect.objectContaining({ value: 1, labels: { lifecycle: "COMPLETED", verdict: "FAILED", edited: "true" } }),
      expect.objectContaining({ value: 1, labels: { lifecycle: "ERRORED", verdict: "none", edited: "false" } }),
    ]);
  });

  it("ignores runs that did not opt in, picked a standard idea, or never selected one, without reading when not opted in", async () => {
    const registry = new Registry();
    const metrics = createWorkerMetrics(registry);
    const read = vi.fn(async () => set("S-2"));
    await recordSelectedDiscoveryOutcome({ metrics, logger }, run(false), "COMPLETED", "PASSED", read);
    expect(read).not.toHaveBeenCalled();
    await recordSelectedDiscoveryOutcome({ metrics, logger }, run(true), "COMPLETED", "PASSED", async () => set("S-1"));
    await recordSelectedDiscoveryOutcome({ metrics, logger }, run(true), "CANCELLED", null, async () => null);
    expect(await samples(registry)).toEqual([]);
  });

  it("never fails the run when its suggestions cannot be read", async () => {
    const metrics = createWorkerMetrics(new Registry());
    await expect(recordSelectedDiscoveryOutcome({ metrics, logger }, run(true), "COMPLETED", "PASSED", async () => {
      throw new Error("db down");
    })).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });
});
