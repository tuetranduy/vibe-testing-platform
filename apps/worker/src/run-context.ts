import { isTerminalLifecycle } from "@platform/contracts";
import {
  EventRepository,
  PlanRepository,
  RequirementRepository,
  ResultRepository,
  RunRepository,
  SecretRepository,
  type TestRun,
} from "@platform/db";
import { createRunEventPublisher } from "@platform/event-bus";
import { createRunRedactor, decryptSecret } from "@platform/security";
import {
  CancelledError,
  ContractError,
  DeadlineExceededError,
  type EventDraft,
  type RunPorts,
  type StageContext,
} from "@platform/testing-engine";
import type { WorkerDeps } from "./deps";
import { NO_VERDICT } from "./metrics";

export interface RunContextHandle {
  ctx: StageContext;
  ports: RunPorts;
  /** Why the run signal fired, if it did. */
  abortReason(): unknown;
  /** Releases everything: cleanups (reverse order), heartbeat, cancel watch, deadline timer. */
  dispose(): Promise<void>;
}

/**
 * Per-run execution context: abort controller (cancel + hard deadline), stage budgets, heartbeat,
 * run redactor built from decrypted secrets, and the lifecycle ports used by the orchestrator.
 */
export async function createRunContext(
  deps: WorkerDeps,
  run: TestRun,
  opts: { deadlineAt: Date; totalBudgetMs: number },
): Promise<RunContextHandle> {
  const now = deps.now ?? (() => new Date());
  const runs = new RunRepository(deps.db);
  const controller = new AbortController();
  const cleanups: (() => Promise<void> | void)[] = [];

  // Secrets: decrypted only here; the redactor masks their values everywhere downstream.
  const secretValues = new Map<string, string>();
  for (const s of await new SecretRepository(deps.db).listActive(run.id)) {
    secretValues.set(s.name, decryptSecret(s, { runId: run.id, name: s.name }, deps.config.secretsKey));
  }
  const redact = createRunRedactor([...secretValues.values()]);
  const publisher = createRunEventPublisher({
    events: new EventRepository(deps.db),
    redis: deps.redis,
    redact,
    logger: deps.logger,
  });

  let lifecycle = run.lifecycle;
  let stageStartedAt = now();

  const abort = (reason: Error) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const deadlineTimer = setTimeout(
    () => abort(new DeadlineExceededError()),
    Math.max(0, opts.deadlineAt.getTime() - now().getTime()),
  );
  const unwatch = await deps.cancelWatcher.watch(run.id, () => abort(new CancelledError()));
  let lastBeat: Promise<void> = Promise.resolve();
  const heartbeat = setInterval(() => {
    lastBeat = runs.heartbeat(run.id).catch((err) => deps.logger.warn({ err, runId: run.id }, "heartbeat failed"));
  }, deps.config.heartbeatMs);

  const ctx: StageContext = {
    runId: run.id,
    tenantId: run.tenantId,
    request: run.request,
    signal: controller.signal,
    deadlineAt: opts.deadlineAt,
    budgets: { explorationMs: Math.floor(opts.totalBudgetMs * 0.6), rerunMs: Math.floor(opts.totalBudgetMs * 0.25) },
    secrets: {
      names: [...secretValues.keys()],
      get: (name) => secretValues.get(name),
    },
    redact,
    publish: async (draft: EventDraft) => {
      await publisher.publish({ ...draft, runId: run.id, stage: lifecycle } as never);
    },
    addCleanup: (fn) => {
      cleanups.push(fn);
    },
    async boundary() {
      if (controller.signal.aborted) throw controller.signal.reason;
      const current = await runs.findById(run.id);
      if (current?.cancelRequestedAt) abort(new CancelledError());
      if (controller.signal.aborted) throw controller.signal.reason;
    },
    budgetSignal: (ms) => AbortSignal.any([controller.signal, AbortSignal.timeout(Math.max(0, ms))]),
    now,
  };

  const ports: RunPorts = {
    lifecycle: () => lifecycle,
    async transition(to, patch = {}) {
      await runs.transition(run.id, lifecycle, to, patch);
      const at = now();
      deps.metrics?.runDuration.observe({ stage: lifecycle }, Math.max(0, at.getTime() - stageStartedAt.getTime()) / 1000);
      stageStartedAt = at;
      lifecycle = to;
      deps.runLogs?.setStage(run.id, to);
      if (isTerminalLifecycle(to)) deps.metrics?.testRuns.inc({ lifecycle: to, verdict: patch.verdict ?? NO_VERDICT });
    },
    publish: ctx.publish,
    saveRequirement: (draft) => new RequirementRepository(deps.db).createRevision(run.id, draft),
    confirmRequirement: (revision) => new RequirementRepository(deps.db).confirm(run.id, revision),
    async getConfirmedRequirement() {
      const req = await new RequirementRepository(deps.db).getLatest(run.id);
      if (!req.confirmedAt) throw new ContractError("Execution started without confirmed criteria");
      return req;
    },
    async savePlan(plan) {
      await new PlanRepository(deps.db).save(plan);
    },
    async saveResults(results) {
      const repo = new ResultRepository(deps.db);
      for (const r of results) await repo.upsert(run.id, r);
      const disagreements = results.filter((r) => r.reason === "DISCOVERY_RERUN_DISAGREE").length;
      if (disagreements > 0) deps.metrics?.reconciliationDisagreements.inc(disagreements);
    },
    enqueueExecute: () => deps.queue.enqueueExecute(run.id),
  };

  // Registered last: nothing above can fail after it, so a registration is always released by dispose().
  const releaseLog = deps.runLogs?.register(run.id, { tenantId: run.tenantId, stage: lifecycle, redact });

  let disposed = false;
  return {
    ctx,
    ports,
    abortReason: () => (controller.signal.aborted ? controller.signal.reason : undefined),
    async dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(deadlineTimer);
      clearInterval(heartbeat);
      await lastBeat;
      unwatch();
      for (const fn of cleanups.reverse()) {
        try {
          await fn();
        } catch (err) {
          deps.logger.warn({ err, runId: run.id }, "cleanup failed");
        }
      }
      secretValues.clear();
      releaseLog?.();
    },
  };
}
