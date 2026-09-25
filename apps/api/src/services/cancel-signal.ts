import { runCancelChannel } from "@platform/event-bus";
import type { Redis } from "ioredis";

export interface CancelSignal {
  send(runId: string): Promise<void>;
}

export function createCancelSignal(redis: Pick<Redis, "publish">): CancelSignal {
  return {
    async send(runId) {
      await redis.publish(runCancelChannel(runId), "cancel");
    },
  };
}
