import type { RunLifecycle, RunVerdict, SuggestionSet } from "@platform/contracts";
import type { TestRun } from "@platform/db";
import type { WorkerLogger } from "./deps";
import { NO_VERDICT, type WorkerMetrics } from "./metrics";

/**
 * Plan §14.2: how runs that execute a selected Browser Use suggestion end (Stagehand exploration, verification and
 * the Playwright rerun), from the existing provenance: the run's opt-in and its selected suggestion's `discovery`
 * tag. Compare with `test_runs_total` for the platform's overall rates. Runs the API ends itself (a cancellation
 * before the worker starts) are not counted here, as with `test_runs_total`'s worker series.
 */
export async function recordSelectedDiscoveryOutcome(
  deps: { metrics?: Pick<WorkerMetrics, "discoverySelectedRuns">; logger: Pick<WorkerLogger, "warn"> },
  run: Pick<TestRun, "id" | "request">,
  lifecycle: RunLifecycle,
  verdict: RunVerdict | null | undefined,
  suggestions: (runId: string) => Promise<SuggestionSet | null>,
): Promise<void> {
  if (!deps.metrics || !run.request.options.autonomousDiscovery) return;
  try {
    const set = await suggestions(run.id);
    const chosen = set?.selected && set.suggestions.find((suggestion) => suggestion.id === set.selected!.suggestionId);
    if (!chosen?.discovery) return;
    deps.metrics.discoverySelectedRuns.inc({ lifecycle, verdict: verdict ?? NO_VERDICT, edited: String(set!.selected!.edited) });
  } catch (err) {
    // Monitoring only: the run's own outcome is already recorded.
    deps.logger.warn({ err, runId: run.id }, "could not record the selected discovery suggestion's outcome");
  }
}
