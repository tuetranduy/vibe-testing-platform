import { TestEventSchema, type TestEvent } from "@platform/contracts";
import type { Redis } from "ioredis";
import { runEventsChannel } from "./channels";

export type Unsubscribe = () => Promise<void>;
type Listener = (event: TestEvent) => void;

/**
 * One Redis subscriber connection shared by many SSE streams. Subscriptions are ref-counted per run;
 * `subscribe` resolves only once Redis confirmed the SUBSCRIBE, so callers can backfill afterwards
 * without a gap.
 */
export class RunEventHub {
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly pending = new Map<string, Promise<unknown>>();

  constructor(private readonly subscriber: Redis) {
    subscriber.on("message", (channel: string, message: string) => {
      const set = this.listeners.get(channel);
      if (!set || set.size === 0) return;
      let event: TestEvent;
      try {
        event = TestEventSchema.parse(JSON.parse(message));
      } catch {
        return; // malformed live message: ignore, the DB backfill is authoritative
      }
      for (const l of set) l(event);
    });
  }

  async subscribe(runId: string, listener: Listener): Promise<Unsubscribe> {
    const channel = runEventsChannel(runId);
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
      this.pending.set(channel, this.subscriber.subscribe(channel));
    }
    set.add(listener);
    await this.pending.get(channel);
    let done = false;
    return async () => {
      if (done) return;
      done = true;
      const s = this.listeners.get(channel);
      if (!s) return;
      s.delete(listener);
      if (s.size === 0) {
        this.listeners.delete(channel);
        this.pending.delete(channel);
        await this.subscriber.unsubscribe(channel).catch(() => {});
      }
    };
  }

  async close(): Promise<void> {
    this.listeners.clear();
    this.subscriber.disconnect();
  }
}

/** Convenience wrapper matching the plan's interface: `subscribeRunEvents(redis, runId, onEvent)`. */
export async function subscribeRunEvents(
  hubOrRedis: RunEventHub | Redis,
  runId: string,
  onEvent: Listener,
): Promise<Unsubscribe> {
  if (hubOrRedis instanceof RunEventHub) return hubOrRedis.subscribe(runId, onEvent);
  const hub = new RunEventHub(hubOrRedis);
  const unsub = await hub.subscribe(runId, onEvent);
  return async () => {
    await unsub();
    await hub.close();
  };
}
