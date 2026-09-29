import { reapRuns, type ReapResult } from "@platform/event-bus";
import type { WorkerDeps } from "../deps";

export type { ReapResult };

/** The reaper (`@platform/event-bus`, shared with the API so it runs while no worker is alive). */
export function reapJob(deps: WorkerDeps): Promise<ReapResult> {
  return reapRuns(deps);
}
