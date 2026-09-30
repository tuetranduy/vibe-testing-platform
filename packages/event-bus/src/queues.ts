import { Queue, type ConnectionOptions } from "bullmq";

export const RUNS_QUEUE = "runs";
export const MAINTENANCE_QUEUE = "maintenance";
/** Artifact retention runs apart from `maintenance`, so a slow artifact store never delays the reaper. */
export const RETENTION_QUEUE = "retention";
export const JOB_ANALYZE_RUN = "analyze-run";
export const JOB_EXECUTE_RUN = "execute-run";
/** A manual rerun (V1.1 F5): the saved Playwright test of another run, no model call. */
export const JOB_RERUN_RUN = "rerun-run";
export const JOB_REAP = "reap";
export const JOB_RETENTION = "retention";

export interface RunJobData {
  runId: string;
}

export const executeJobId = (runId: string) => `execute-run__${runId}`;
export const analyzeJobId = (runId: string) => `analyze-run__${runId}`;
export const rerunJobId = (runId: string) => `rerun-run__${runId}`;
/**
 * The analyze-run job enqueued when a user selects a suggested test. Its own id: the same run's survey
 * job is kept once completed (removeOnComplete) and BullMQ ignores an add whose id exists, so reusing
 * analyzeJobId would silently drop this job.
 */
export const analyzeAfterSelectionJobId = (runId: string) => `analyze-run__${runId}__selected`;

/** Enqueue side of the `runs` queue. Payload is `{ runId }` only; no retries (D10). */
export interface RunQueue {
  enqueueAnalyze(runId: string): Promise<void>;
  /** analyze-run for the text a user selected (the run is ANALYZING_REQUIREMENT); see analyzeAfterSelectionJobId. */
  enqueueAnalyzeAfterSelection(runId: string): Promise<void>;
  enqueueExecute(runId: string): Promise<void>;
  /** rerun-run for a manual rerun's run (QUEUED, `request.rerunOf` set). */
  enqueueRerun(runId: string): Promise<void>;
  /** True while the rerun-run job for this run is waiting or being processed. */
  isRerunPending(runId: string): Promise<boolean>;
  /** True while the execute-run job for this run is waiting/delayed (not yet picked up). */
  isExecuteWaiting(runId: string): Promise<boolean>;
  /** True while the post-selection analyze-run job for this run is waiting/delayed (not yet picked up). */
  isAnalyzeAfterSelectionWaiting(runId: string): Promise<boolean>;
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
    async enqueueAnalyzeAfterSelection(runId) {
      await queue.add(JOB_ANALYZE_RUN, { runId }, { ...JOB_OPTS, jobId: analyzeAfterSelectionJobId(runId) });
    },
    async enqueueExecute(runId) {
      await queue.add(JOB_EXECUTE_RUN, { runId }, { ...JOB_OPTS, jobId: executeJobId(runId) });
    },
    async enqueueRerun(runId) {
      await queue.add(JOB_RERUN_RUN, { runId }, { ...JOB_OPTS, jobId: rerunJobId(runId) });
    },
    async isRerunPending(runId) {
      const state = await queue.getJobState(rerunJobId(runId));
      return ["waiting", "delayed", "prioritized", "waiting-children", "active"].includes(state);
    },
    async isExecuteWaiting(runId) {
      const state = await queue.getJobState(executeJobId(runId));
      return state === "waiting" || state === "delayed" || state === "prioritized" || state === "waiting-children";
    },
    async isAnalyzeAfterSelectionWaiting(runId) {
      const state = await queue.getJobState(analyzeAfterSelectionJobId(runId));
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

/** Suite schedules (V1.2 F3): one BullMQ job scheduler per enabled schedule, keyed by the schedule's id. */
export const SUITE_SCHEDULES_QUEUE = "suite-schedules";
export const JOB_FIRE_SCHEDULE = "fire-schedule";

export interface ScheduleJobData {
  scheduleId: string;
}

/** Keeps BullMQ's job schedulers in step with the `suite_schedules` table (the table is the truth). */
export interface ScheduleSync {
  /** Creates or replaces the schedule's job scheduler. */
  upsert(schedule: { id: string; cron: string; timezone: string }): Promise<void>;
  remove(scheduleId: string): Promise<void>;
  /** The ids of every job scheduler (to remove those whose schedule is gone or disabled). */
  ids(): Promise<string[]>;
  close(): Promise<void>;
}

export function createScheduleSync(connection: ConnectionOptions): ScheduleSync {
  const queue = new Queue<ScheduleJobData>(SUITE_SCHEDULES_QUEUE, { connection });
  return {
    async upsert(s) {
      await queue.upsertJobScheduler(
        s.id,
        { pattern: s.cron, tz: s.timezone },
        { name: JOB_FIRE_SCHEDULE, data: { scheduleId: s.id }, opts: { attempts: 1, removeOnComplete: 100, removeOnFail: 100 } },
      );
    },
    async remove(scheduleId) {
      await queue.removeJobScheduler(scheduleId);
    },
    async ids() {
      const schedulers = await queue.getJobSchedulers(0, -1);
      return schedulers.map((s) => s.key);
    },
    close: () => queue.close(),
  };
}
