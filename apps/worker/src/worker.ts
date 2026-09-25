import {
  JOB_ANALYZE_RUN,
  JOB_EXECUTE_RUN,
  JOB_REAP,
  MAINTENANCE_QUEUE,
  RUNS_QUEUE,
  type RunJobData,
} from "@platform/event-bus";
import { Queue, Worker, type ConnectionOptions, type Job } from "bullmq";
import type { WorkerDeps } from "./deps";
import { analyzeRunJob } from "./jobs/analyze-run";
import { executeRunJob } from "./jobs/execute-run";
import { reapJob } from "./jobs/reap";

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
  opts: { connection: ConnectionOptions; concurrency: number; reapEveryMs?: number },
): Promise<RunningWorkers> {
  const runs = new Worker<RunJobData>(
    RUNS_QUEUE,
    async (job: Job<RunJobData>) => {
      const { runId } = job.data;
      if (job.name === JOB_ANALYZE_RUN) return analyzeRunJob(deps, runId);
      if (job.name === JOB_EXECUTE_RUN) return executeRunJob(deps, runId);
      deps.logger.warn({ job: job.name }, "unknown job");
    },
    { connection: opts.connection, concurrency: opts.concurrency, maxStalledCount: 0, lockDuration: 30_000 },
  );

  const maintenanceQueue = new Queue(MAINTENANCE_QUEUE, { connection: opts.connection });
  await maintenanceQueue.upsertJobScheduler(
    JOB_REAP,
    { every: opts.reapEveryMs ?? 60_000 },
    { name: JOB_REAP, opts: { attempts: 1, removeOnComplete: 100, removeOnFail: 100 } },
  );
  const maintenance = new Worker(
    MAINTENANCE_QUEUE,
    async (job) => {
      if (job.name === JOB_REAP) {
        const r = await reapJob(deps);
        if (r.workerLost.length || r.confirmationExpired.length || r.secretsPurged.length) {
          deps.logger.info(r, "reaper acted");
        }
      }
    },
    { connection: opts.connection, concurrency: 1, maxStalledCount: 0 },
  );

  for (const w of [runs, maintenance]) {
    w.on("failed", (job, err) => deps.logger.error({ job: job?.name, runId: job?.data?.runId, err }, "job failed"));
    w.on("error", (err) => deps.logger.error({ err }, "worker error"));
  }

  return {
    async close() {
      await runs.close();
      await maintenance.close();
      await maintenanceQueue.close();
    },
  };
}
