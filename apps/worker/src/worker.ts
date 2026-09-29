import {
  JOB_ANALYZE_RUN,
  JOB_EXECUTE_RUN,
  JOB_RERUN_RUN,
  JOB_RETENTION,
  RETENTION_QUEUE,
  RUNS_QUEUE,
  startReaper,
  type RunJobData,
} from "@platform/event-bus";
import { Queue, Worker, type ConnectionOptions, type Job } from "bullmq";
import type { WorkerDeps } from "./deps";
import { analyzeRunJob } from "./jobs/analyze-run";
import { executeRunJob } from "./jobs/execute-run";
import { rerunRunJob } from "./jobs/rerun-run";
import { pruneExplorationCache, retentionJob } from "./jobs/retention";

export interface RunningWorkers {
  close(): Promise<void>;
}

/**
 * Starts the BullMQ workers. No retries anywhere (D10): jobs are enqueued with attempts: 1 and
 * `maxStalledCount: 0` makes a job whose worker died fail instead of being re-run; the reaper
 * then marks its run ERRORED / WORKER_LOST.
 */
export async function startWorkers(
  deps: WorkerDeps,
  opts: { connection: ConnectionOptions; concurrency: number; reapEveryMs?: number; retentionEveryMs?: number },
): Promise<RunningWorkers> {
  const runs = new Worker<RunJobData>(
    RUNS_QUEUE,
    async (job: Job<RunJobData>) => {
      const { runId } = job.data;
      if (job.name === JOB_ANALYZE_RUN) return analyzeRunJob(deps, runId);
      if (job.name === JOB_EXECUTE_RUN) return executeRunJob(deps, runId);
      if (job.name === JOB_RERUN_RUN) return rerunRunJob(deps, runId);
      deps.logger.warn({ job: job.name }, "unknown job");
    },
    { connection: opts.connection, concurrency: opts.concurrency, maxStalledCount: 0, lockDuration: 30_000 },
  );

  // The reaper runs in the API too (@platform/event-bus): one of them per tick, and still one when no worker is up.
  const reaper = await startReaper(deps, { connection: opts.connection, ...(opts.reapEveryMs ? { everyMs: opts.reapEveryMs } : {}) });

  // Retention has its own queue and worker: a pass stuck on the artifact store (or a large backlog)
  // must never hold up the reaper, which detects lost workers.
  const retentionQueue = new Queue(RETENTION_QUEUE, { connection: opts.connection });
  const storage = deps.storage;
  let retention: Worker | undefined;
  if (storage) {
    await retentionQueue.upsertJobScheduler(
      JOB_RETENTION,
      { every: opts.retentionEveryMs ?? 24 * 3_600_000 },
      { name: JOB_RETENTION, opts: { attempts: 1, removeOnComplete: 30, removeOnFail: 30 } },
    );
    retention = new Worker(
      RETENTION_QUEUE,
      async () => {
        const r = await retentionJob({ db: deps.db, storage, logger: deps.logger, ...(deps.now ? { now: deps.now } : {}) });
        if (r.deleted > 0 || r.failed > 0) deps.logger.info(r, "retention acted");
        const pruned = await pruneExplorationCache({ db: deps.db, ...(deps.now ? { now: deps.now } : {}) }).catch((err: unknown) => {
          deps.logger.warn({ err }, "exploration cache could not be pruned; retrying next pass");
          return 0;
        });
        if (pruned > 0) deps.logger.info({ pruned }, "unused exploration cache entries deleted");
      },
      { connection: opts.connection, concurrency: 1, maxStalledCount: 0 },
    );
  }

  for (const w of [runs, ...(retention ? [retention] : [])]) {
    w.on("failed", (job, err) => deps.logger.error({ job: job?.name, runId: job?.data?.runId, err }, "job failed"));
    w.on("error", (err) => deps.logger.error({ err }, "worker error"));
  }

  return {
    async close() {
      await runs.close();
      await reaper.close();
      await retention?.close();
      await retentionQueue.close();
    },
  };
}
