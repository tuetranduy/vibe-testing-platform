import { Queue, type ConnectionOptions } from "bullmq";

export const RUNS_QUEUE = "runs";
export const MAINTENANCE_QUEUE = "maintenance";
/** Artifact retention runs apart from `maintenance`, so a slow artifact store never delays the reaper. */
export const RETENTION_QUEUE = "retention";
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
  /** True while the analyze-run job for this run is waiting or being processed. */
  isAnalyzePending(runId: string): Promise<boolean>;
  close(): Promise<void>;
  /** Jobs waiting to be picked up (waiting, delayed, prioritized, waiting-children). Optional for fakes. */
  depth?(): Promise<number>;
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
    async isAnalyzePending(runId) {
      const state = await queue.getJobState(analyzeJobId(runId));
      return ["waiting", "delayed", "prioritized", "waiting-children", "active"].includes(state);
    },
    async depth() {
      const counts = await queue.getJobCounts("waiting", "delayed", "prioritized", "waiting-children");
      return Object.values(counts).reduce((a, b) => a + b, 0);
    },
    close: () => queue.close(),
  };
}
