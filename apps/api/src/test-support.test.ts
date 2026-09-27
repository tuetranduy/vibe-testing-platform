import type { RunQueue } from "@platform/event-bus";
import { describe, expect, it } from "vitest";
import { FakeQueue, createTestApi } from "./test-support";

describe("createTestApi", () => {
  it("hands back the FakeQueue the app uses, and takes no other kind of queue", async () => {
    const queue = new FakeQueue();
    const t = await createTestApi({}, { queue });
    try {
      expect(t.queue).toBe(queue);
      expect(t.deps.queue).toBe(queue);
    } finally {
      await t.close();
    }
    // Any other queue would come back as `t.queue`, typed as a FakeQueue it is not.
    // @ts-expect-error — `extra.queue` must be a FakeQueue
    void (() => createTestApi({}, { queue: {} as RunQueue }));
  });
});
