import { RerunResultSchema, traceRecordingOn, videoRecordingOn, type GeneratedTest, type RerunResult } from "@platform/contracts";
import { collectEvidence, type EvidenceStore } from "../evidence/collector";
import type { EngineStages, StageContext } from "../orchestrator/stages";
import { redactedCause } from "../shared/log-cause";
import { runGeneratedTest, type RerunLogger, type RunGeneratedTestResult, type SpawnRunner } from "./runner";
import { removeWorkspace, type WorkspaceConfig } from "./workspace";

/** The rerun's own egress proxy (Ruling R31), started by the worker for RUNNING_PLAYWRIGHT. */
export interface RerunProxy {
  /** `http://127.0.0.1:<port>` */
  url: string;
  close(): Promise<void>;
}

/** Injected dependencies of the real RUNNING_PLAYWRIGHT stage (the worker supplies them). */
export interface RunTestStageDeps {
  openProxy(ctx: StageContext): Promise<RerunProxy>;
  spawn: SpawnRunner;
  workspace: WorkspaceConfig;
  evidence(ctx: StageContext): EvidenceStore;
  actionTimeoutMs?: number;
  expectTimeoutMs?: number;
  /** Receives the (redacted) cause of an infrastructure failure: proxy, workspace, spawn, browser. */
  logger?: RerunLogger | undefined;
}

/** At most this much of the time left before the deadline is kept for evidence upload and the report stage. */
const REPORT_RESERVE_MAX_MS = 30_000;

/**
 * The rerun's budget: `budgets.rerunMs`, capped by the time left before `ctx.deadlineAt` minus a
 * reserve for what follows (evidence upload, then the report: reconcile, persistence, time-boxed
 * diagnostics) — a quarter of what is left, at most 30 s. Never negative. So a long planning or
 * exploration phase costs the rerun its time (rerun ERRORED, Ruling R41), not the run its verdict
 * (run ERRORED / TIMEOUT at the hard deadline).
 */
export function rerunTimeoutMs(ctx: Pick<StageContext, "budgets" | "deadlineAt" | "now">): number {
  if (!ctx.deadlineAt) return ctx.budgets.rerunMs;
  const remaining = ctx.deadlineAt.getTime() - ctx.now().getTime();
  const reserve = Math.min(REPORT_RESERVE_MAX_MS, Math.floor(remaining / 4));
  return Math.max(0, Math.min(ctx.budgets.rerunMs, remaining - reserve));
}

const once = (fn: () => Promise<void>) => {
  let done: Promise<void> | undefined;
  return () => (done ??= fn());
};

/**
 * The real RUNNING_PLAYWRIGHT stage (Task 17): proxy → sandboxed rerun (runner.ts) → scrubbed
 * evidence (evidence/collector.ts) → workspace removed → RerunResult with the evidence's artifact
 * ids (Ruling R27). It does not publish `playwright.completed`: `runExecution` does (Ruling R34).
 *
 * Ruling R41: a rerun that fails on its own is ERRORED and the run goes on to its report; only the
 * run signal (cancel / hard deadline) throws its reason, once the child is killed. Infrastructure
 * failures are logged with their cause (the run's redactor applied); the run records a template. Cleanups are
 * registered on the context, so an abandoned stage still kills the child (the runner watches the
 * run signal), then deletes the workspace and closes the proxy.
 */
export function createRunTestStage(deps: RunTestStageDeps): EngineStages["runTest"] {
  return async (ctx: StageContext, test: GeneratedTest): Promise<RerunResult> => {
    const secrets: Record<string, string> = {};
    for (const name of ctx.secrets.names) {
      const value = ctx.secrets.get(name);
      if (value !== undefined) secrets[name] = value;
    }

    let proxy: RerunProxy;
    try {
      proxy = await deps.openProxy(ctx);
    } catch (err) {
      if (ctx.signal.aborted) throw ctx.signal.reason;
      deps.logger?.error({ runId: ctx.runId, err: redactedCause(err, ctx.redact) }, "the rerun's network guard could not be started (egress proxy)");
      return RerunResultSchema.parse({
        status: "ERRORED",
        perCriterion: Object.fromEntries(test.compiledCriteria.map((id) => [id, "NOT_REACHED"])),
        errorText: Object.fromEntries(test.compiledCriteria.map((id) => [id, "The rerun's network guard could not be started"])),
        durationMs: 0,
      });
    }
    const closeProxy = once(() => proxy.close());
    ctx.addCleanup(closeProxy);

    const running = runGeneratedTest(
      {
        runId: ctx.runId,
        test,
        secrets,
        proxyUrl: proxy.url,
        timeoutMs: rerunTimeoutMs(ctx),
        signal: ctx.signal,
        record: { video: videoRecordingOn(ctx.request), trace: traceRecordingOn(ctx.request) },
      },
      deps,
    );
    // The child is gone once `running` settles (aborts kill it); only then is the workspace deleted.
    const cleanUp = once(async () => {
      await running.catch(() => {});
      await removeWorkspace(deps.workspace, ctx.runId);
    });
    ctx.addCleanup(cleanUp);

    try {
      const out: RunGeneratedTestResult = await running;
      await closeProxy();
      if (ctx.signal.aborted) throw ctx.signal.reason;
      const artifactIds = await collectEvidence(ctx, out.artifacts, { store: deps.evidence(ctx), secretValues: Object.values(secrets) });
      // The collector stops at the run signal; the stage then throws its reason (never a partial result).
      if (ctx.signal.aborted) throw ctx.signal.reason;
      return RerunResultSchema.parse({
        status: out.status,
        perCriterion: out.perCriterion,
        durationMs: out.durationMs,
        // Error text can quote page content or a filled value: the run's redactor applies (by value).
        errorText: ctx.redact(out.errorText),
        artifactIds,
      });
    } finally {
      await closeProxy();
      await cleanUp();
    }
  };
}
