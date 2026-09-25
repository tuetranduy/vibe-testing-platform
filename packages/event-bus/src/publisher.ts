import { TestEventSchema, type TestEvent, type TestEventInput } from "@platform/contracts";
import type { EventRepository } from "@platform/db";
import type { Redis } from "ioredis";
import { runEventsChannel } from "./channels";

export interface PublisherLogger {
  warn(obj: object, msg: string): void;
}

export interface RunEventPublisherDeps {
  events: EventRepository;
  redis: Pick<Redis, "publish">;
  /** Run redactor (key + value). Applied before anything is persisted or published. */
  redact: (value: unknown) => unknown;
  logger?: PublisherLogger;
}

export interface RunEventPublisher {
  /** validate → redact → persist (sequence allocated) → Redis PUBLISH. */
  publish(input: TestEventInput): Promise<TestEvent>;
  /** Validate + redact only; for callers that persist inside their own transaction. */
  prepare(input: TestEventInput): TestEventInput;
  /** Live notification for an event already persisted (e.g. after a transaction commits). */
  notify(event: TestEvent): Promise<void>;
}

function validateInput(input: TestEventInput): void {
  // id/sequence/timestamp are placeholders — they are assigned on persist.
  TestEventSchema.parse({ ...input, id: "evt_validate", sequence: 1, timestamp: new Date(0).toISOString() });
}

export function createRunEventPublisher(deps: RunEventPublisherDeps): RunEventPublisher {
  const prepare = (input: TestEventInput): TestEventInput => {
    validateInput(input);
    const redacted = {
      ...input,
      message: deps.redact(input.message) as string,
      payload: deps.redact(input.payload),
    } as TestEventInput;
    validateInput(redacted);
    return redacted;
  };

  const notify = async (event: TestEvent): Promise<void> => {
    try {
      await deps.redis.publish(runEventsChannel(event.runId), JSON.stringify(event));
    } catch (err) {
      // The event is durable in the database; SSE clients will pick it up on backfill.
      deps.logger?.warn({ err, runId: event.runId, sequence: event.sequence }, "redis publish failed");
    }
  };

  return {
    prepare,
    notify,
    async publish(input) {
      const event = await deps.events.append(prepare(input));
      await notify(event);
      return event;
    },
  };
}
