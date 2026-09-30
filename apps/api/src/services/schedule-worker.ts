import { SUITE_SCHEDULES_QUEUE, type ScheduleJobData } from "@platform/event-bus";
import { Worker, type ConnectionOptions } from "bullmq";
import type { ApiDeps } from "../deps";
import { ScheduleService } from "./schedule-service";

export interface ScheduleWorkerLogger {
  info(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

/**
 * Consumes the suite-schedules queue (V1.2 F3): each job is one firing of one schedule. Before that, makes the
 * job schedulers match the `suite_schedules` table, so schedules survive a Redis that lost them and deleted or
 * disabled ones stop firing.
 */
export async function startScheduleWorker(
  deps: ApiDeps,
  opts: { connection: ConnectionOptions; logger: ScheduleWorkerLogger },
): Promise<{ close(): Promise<void> }> {
  const service = new ScheduleService(deps);
  const synced = await service.resync();
  opts.logger.info(synced, "suite schedules synced");
  const worker = new Worker<ScheduleJobData>(
    SUITE_SCHEDULES_QUEUE,
    async (job) => {
      const result = await service.fire(job.data.scheduleId);
      opts.logger.info({ scheduleId: job.data.scheduleId, ...result }, "suite schedule fired");
    },
    { connection: opts.connection, concurrency: 1, maxStalledCount: 0 },
  );
  worker.on("failed", (job, err) => opts.logger.error({ scheduleId: job?.data?.scheduleId, err }, "suite schedule firing failed"));
  worker.on("error", (err) => opts.logger.error({ err }, "schedule worker error"));
  return { close: () => worker.close() };
}
