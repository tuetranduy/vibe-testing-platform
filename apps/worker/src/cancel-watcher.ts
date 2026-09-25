import { runCancelChannel } from "@platform/event-bus";
import type { Redis } from "ioredis";

/** One pattern subscription (`run-cancel:*`) shared by every run on this worker. */
export class CancelWatcher {
  private readonly listeners = new Map<string, Set<() => void>>();
  private ready: Promise<unknown>;

  constructor(private readonly subscriber: Redis) {
    subscriber.on("pmessage", (_pattern: string, channel: string) => {
      const runId = channel.slice(runCancelChannel("").length);
      for (const l of this.listeners.get(runId) ?? []) l();
    });
    this.ready = subscriber.psubscribe(runCancelChannel("*"));
  }

  async watch(runId: string, onCancel: () => void): Promise<() => void> {
    await this.ready;
    let set = this.listeners.get(runId);
    if (!set) this.listeners.set(runId, (set = new Set()));
    set.add(onCancel);
    return () => {
      set!.delete(onCancel);
      if (set!.size === 0) this.listeners.delete(runId);
    };
  }

  close(): void {
    this.listeners.clear();
    this.subscriber.disconnect();
  }
}
