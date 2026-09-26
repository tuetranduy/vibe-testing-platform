import { BrowserProviderError, CancelledError, EngineError, type ExplorationOutcome } from "@platform/contracts";
import type { BrowserExplorer, ExplorerSession, SandboxedPage } from "@platform/stagehand-adapter/browser-explorer";
import type { EngineStages, StageContext } from "../orchestrator/stages";
import { runExploration, type ExplorationStore, type RecorderPort } from "./executor";

/** A run's sandboxed browser (the worker's `RunSandbox`): the explorer's page plus teardown. */
export interface ExplorationSandbox extends SandboxedPage {
  close(): Promise<void>;
}

/** Injected dependencies of the real explore stage (Ruling R12). */
export interface ExploreStageDeps {
  /** Opens the run's browser sandbox (egress proxy, Chromium with the Stagehand extension, navigation guard). */
  openSandbox(ctx: StageContext): Promise<ExplorationSandbox>;
  explorer: BrowserExplorer;
  /** Persistence for this run's steps, facts and screenshots. */
  store(ctx: StageContext): ExplorationStore;
  recorder?: RecorderPort;
  pollIntervalMs?: number;
  /**
   * Receives the raw error when the sandbox or the explorer fails to start (it may carry Chromium's
   * stderr). Only the log sees it: the run records a short template message.
   */
  logger?: { error(obj: object, msg?: string): void };
}

/** Which start-up step failed, for the user-facing template message. */
const START_FAILURES = {
  sandbox: "Browser sandbox failed to start",
  explorer: "Browser explorer failed to start",
} as const;

/**
 * The real `explore` stage (Task 14): sandbox → explorer session (bounded by the exploration
 * budget) → executor. The session and the sandbox are always released: in `finally`, and through
 * `ctx.addCleanup` in case the orchestrator abandons the stage on abort.
 */
export function createExploreStage(deps: ExploreStageDeps): EngineStages["explore"] {
  return async (ctx, plan, requirement): Promise<ExplorationOutcome> => {
    const budget = ctx.budgetSignal(ctx.budgets.explorationMs);
    let sandbox: ExplorationSandbox | undefined;
    let session: ExplorerSession | undefined;
    let starting: keyof typeof START_FAILURES | null = "sandbox";
    try {
      sandbox = await deps.openSandbox(ctx);
      const opened = sandbox;
      ctx.addCleanup(() => opened.close());
      starting = "explorer";
      session = await deps.explorer.start({
        page: sandbox,
        runId: ctx.runId,
        // Operations in flight stop when the budget runs out (or the run is cancelled / times out).
        signal: budget,
        redact: ctx.redact,
        deadlineAt: ctx.deadlineAt,
      });
      const started = session;
      ctx.addCleanup(() => started.close());
      starting = null;
      return await runExploration(ctx, { plan, requirement, session, budget }, {
        store: deps.store(ctx),
        ...(deps.recorder ? { recorder: deps.recorder } : {}),
        ...(deps.pollIntervalMs !== undefined ? { pollIntervalMs: deps.pollIntervalMs } : {}),
      });
    } catch (err) {
      if (ctx.signal.aborted) throw ctx.signal.reason;
      // The budget ran out while the browser or the explorer was still starting: nothing explored.
      if (budget.aborted) return { steps: [], facts: [], stopReason: "EXPLORATION_BUDGET_EXHAUSTED" };
      // Launch / proxy / extension failures are the browser provider's, not INTERNAL. The raw message
      // (e.g. Chromium's stderr tail) stays in the worker log, never in the run's error or events.
      if (starting && !(err instanceof EngineError) && !(err instanceof CancelledError)) {
        const message = START_FAILURES[starting];
        deps.logger?.error({ err, runId: ctx.runId }, message.toLowerCase());
        throw new BrowserProviderError(message, { cause: err });
      }
      throw err;
    } finally {
      await session?.close().catch(() => {});
      await sandbox?.close().catch(() => {});
    }
  };
}
