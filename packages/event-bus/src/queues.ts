import { Queue, type ConnectionOptions } from "bullmq";

export const RUNS_QUEUE = "runs";
export const MAINTENANCE_QUEUE = "maintenance";
export const JOB_ANALYZE_RUN = "analyze-run";
export const JOB_EXECUTE_RUN = "execute-run";
export const JOB_REAP = "reap";
export const JOB_RETENTION = "retention";

export interface RunJobData {
  runId: string;
}

export const executeJobId = (runId: string) => `execute-run__${runId}`;
export const analyzeJobId = (runId: string) => `analyze-run__${runId}`;

/** Enqueue side of the `runs` queue. Payload is `{ runId }` only; no retries (D10). */
export interface RunQueue {
  enqueueAnalyze(runId: string): Promise<void>;
  enqueueExecute(runId: string): Promise<void>;
  /** True while the execute-run job for this run is waiting/delayed (not yet picked up). */
  isExecuteWaiting(runId: string): Promise<boolean>;
  close(): Promise<void>;
}

const JOB_OPTS = { attempts: 1, removeOnComplete: 1000, removeOnFail: 5000 } as const;

export function createRunQueue(connection: ConnectionOptions): RunQueue {
  const queue = new Queue<RunJobData>(RUNS_QUEUE, { connection });
  return {
    async enqueueAnalyze(runId) {
      await queue.add(JOB_ANALYZE_RUN, { runId }, { ...JOB_OPTS, jobId: analyzeJobId(runId) });
    },
    async enqueueExecute(runId) {
      await queue.add(JOB_EXECUTE_RUN, { runId }, { ...JOB_OPTS, jobId: executeJobId(runId) });
    },
    async isExecuteWaiting(runId) {
      const state = await queue.getJobState(executeJobId(runId));
      return state === "waiting" || state === "delayed" || state === "prioritized" || state === "waiting-children";
    },
    close: () => queue.close(),
  };
}
