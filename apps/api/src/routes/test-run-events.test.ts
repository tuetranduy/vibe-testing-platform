import type { TestEvent, TestEventInput } from "@platform/contracts";
import { EventRepository, RunRepository } from "@platform/db";
import { OTHER_TENANT_ID, TEST_TENANT_ID } from "@platform/db/testing";
import { createRunEventPublisher } from "@platform/event-bus";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { auth, createTestApi, type TestApi } from "../test-support";

let t: TestApi;
let base: string;
beforeAll(async () => {
  t = await createTestApi({ sseHeartbeatMs: 100 });
  await t.app.listen({ port: 0, host: "127.0.0.1" });
  const addr = t.app.server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(async () => t?.close());
afterEach(() => vi.restoreAllMocks());

const request = {
  targetUrl: "https://x.com",
  requirement: "Requirement text",
  environment: "staging" as const,
  browser: "chromium" as const,
  testData: {},
  secretNames: [],
  options: {} as never,
};

const newRun = (tenantId = TEST_TENANT_ID) =>
  new RunRepository(t.tdb.db).create({ tenantId, targetUrl: "https://x.com", request });

const publisher = () => createRunEventPublisher({ events: new EventRepository(t.tdb.db), redis: t.redis, redact: (v) => v });

const stageEvent = (runId: string, i: number): TestEventInput => ({
  runId,
  stage: "EXPLORING",
  type: "step.recorded",
  message: `Step ${i}`,
  payload: { stepId: `st_${i}`, index: i, kind: "act", outcome: "SUCCESS", blockReason: null },
});

interface Frame {
  id?: string;
  event?: string;
  data?: string;
  comment?: string;
}

/** Minimal SSE client over fetch that records raw frames. */
function openStream(runId: string, opts: { query?: string; headers?: Record<string, string> } = {}) {
  const ac = new AbortController();
  const frames: Frame[] = [];
  let ended = false;
  const done = (async () => {
    const res = await fetch(`${base}/v1/test-runs/${runId}/events${opts.query ?? ""}`, {
      headers: { ...auth, ...opts.headers },
      signal: ac.signal,
    });
    if (res.status !== 200) {
      ended = true;
      return res.status;
    }
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const f: Frame = {};
          for (const line of block.split("\n")) {
            if (line.startsWith(":")) f.comment = line.slice(1).trim();
            else {
              const [k, ...v] = line.split(": ");
              (f as Record<string, string>)[k!] = v.join(": ");
            }
          }
          frames.push(f);
        }
      }
    } catch {
      /* aborted */
    }
    ended = true;
    return 200;
  })();
  const events = () =>
    frames.filter((f) => f.data).map((f) => JSON.parse(f.data!) as TestEvent);
  return { frames, events, done, isEnded: () => ended, close: () => ac.abort() };
}

describe("GET /v1/test-runs/:runId/events", () => {
  it("backfills events after afterSequence with id/event/data framing", async () => {
    const run = await newRun();
    for (let i = 1; i <= 3; i++) await publisher().publish(stageEvent(run.id, i));
    const s = openStream(run.id, { query: "?afterSequence=1" });
    await vi.waitFor(() => expect(s.events().map((e) => e.sequence)).toEqual([2, 3]));
    const f = s.frames.find((x) => x.id === "2")!;
    expect(f.event).toBe("step.recorded");
    expect(JSON.parse(f.data!).payload.stepId).toBe("st_2");
    s.close();
  });

  it("honours Last-Event-ID, and the larger cursor wins when both are given", async () => {
    const run = await newRun();
    for (let i = 1; i <= 4; i++) await publisher().publish(stageEvent(run.id, i));
    const a = openStream(run.id, { headers: { "last-event-id": "2" } });
    await vi.waitFor(() => expect(a.events().map((e) => e.sequence)).toEqual([3, 4]));
    a.close();
    const b = openStream(run.id, { query: "?afterSequence=1", headers: { "last-event-id": "3" } });
    await vi.waitFor(() => expect(b.events().map((e) => e.sequence)).toEqual([4]));
    b.close();
    const c = openStream(run.id, { query: "?afterSequence=3", headers: { "last-event-id": "1" } });
    await vi.waitFor(() => expect(c.events().map((e) => e.sequence)).toEqual([4]));
    c.close();
  });

  it("streams live events after the backfill", async () => {
    const run = await newRun();
    await publisher().publish(stageEvent(run.id, 1));
    const s = openStream(run.id);
    await vi.waitFor(() => expect(s.events()).toHaveLength(1));
    await publisher().publish(stageEvent(run.id, 2));
    await publisher().publish(stageEvent(run.id, 3));
    await vi.waitFor(() => expect(s.events().map((e) => e.sequence)).toEqual([1, 2, 3]));
    s.close();
  });

  it.each(["before", "after"] as const)(
    "gap race: an event published %s the backfill query is delivered exactly once, in order",
    async (when) => {
      const run = await newRun();
      await publisher().publish(stageEvent(run.id, 1));
      const original = EventRepository.prototype.listAfter;
      let fired = false;
      vi.spyOn(EventRepository.prototype, "listAfter").mockImplementation(async function (this: EventRepository, ...args) {
        if (!fired && args[0] === run.id) {
          fired = true;
          if (when === "before") {
            await publisher().publish(stageEvent(run.id, 2));
            return original.apply(this, args);
          }
          const rows = await original.apply(this, args);
          await publisher().publish(stageEvent(run.id, 2));
          return rows;
        }
        return original.apply(this, args);
      });
      const s = openStream(run.id);
      await vi.waitFor(() => expect(s.events().map((e) => e.sequence)).toEqual([1, 2]));
      await publisher().publish(stageEvent(run.id, 3));
      await vi.waitFor(() => expect(s.events().map((e) => e.sequence)).toEqual([1, 2, 3]));
      s.close();
    },
  );

  it("fills a gap when a live event skips ahead of an undelivered one", async () => {
    const run = await newRun();
    const s = openStream(run.id);
    await vi.waitFor(() => expect(s.frames.some((f) => f.comment === "connected")).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    // Persist 1 and 2 without live notification, then notify only 2.
    const pub = publisher();
    const events = new EventRepository(t.tdb.db);
    await events.append(pub.prepare(stageEvent(run.id, 1)));
    const e2 = await events.append(pub.prepare(stageEvent(run.id, 2)));
    await pub.notify(e2);
    await vi.waitFor(() => expect(s.events().map((e) => e.sequence)).toEqual([1, 2]));
    s.close();
  });

  it("does not drop an event published while a buffered gap is being filled", async () => {
    const run = await newRun();
    const pub = publisher();
    const events = new EventRepository(t.tdb.db);
    await pub.publish(stageEvent(run.id, 1));
    const original = EventRepository.prototype.listAfter;
    let call = 0;
    vi.spyOn(EventRepository.prototype, "listAfter").mockImplementation(async function (this: EventRepository, ...args) {
      if (args[0] === run.id) {
        call++;
        if (call === 1) {
          // Initial backfill: 2 and 3 persist, but only 3's live message arrives (out of order).
          const rows = await original.apply(this, args);
          await events.append(pub.prepare(stageEvent(run.id, 2)));
          await pub.notify(await events.append(pub.prepare(stageEvent(run.id, 3))));
          await new Promise((r) => setTimeout(r, 50));
          return rows;
        }
        if (call === 2) {
          // Gap-filling backfill: the terminal event is published meanwhile.
          const rows = await original.apply(this, args);
          await pub.publish({ runId: run.id, stage: "COMPLETED", type: "run.completed", message: "Done", payload: { verdict: "PASSED" } });
          await new Promise((r) => setTimeout(r, 50));
          return rows;
        }
      }
      return original.apply(this, args);
    });
    const s = openStream(run.id);
    expect(await s.done).toBe(200);
    expect(s.events().map((e) => e.sequence)).toEqual([1, 2, 3, 4]);
  });

  it("closes via the heartbeat DB check when the terminal event's live message is lost", { timeout: 15_000 }, async () => {
    const run = await newRun();
    const s = openStream(run.id);
    await vi.waitFor(() => expect(s.frames.some((f) => f.comment === "connected")).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    const pub = publisher();
    await new RunRepository(t.tdb.db).transition(run.id, "QUEUED", "CANCELLED", { cancelReason: "USER_REQUESTED" });
    // Persist without the Redis notification.
    await new EventRepository(t.tdb.db).append(
      pub.prepare({ runId: run.id, stage: "CANCELLED", type: "run.cancelled", message: "Cancelled", payload: { reason: "USER_REQUESTED" } }),
    );
    expect(await s.done).toBe(200);
    expect(s.events().map((e) => e.type)).toEqual(["run.cancelled"]);
  });

  it("sends heartbeat comments", async () => {
    const run = await newRun();
    const s = openStream(run.id);
    await vi.waitFor(() => expect(s.frames.filter((f) => f.comment === "ping").length).toBeGreaterThanOrEqual(2));
    s.close();
  });

  it("closes after the terminal event is delivered", async () => {
    const run = await newRun();
    const s = openStream(run.id);
    await vi.waitFor(() => expect(s.frames.length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 50));
    await publisher().publish(stageEvent(run.id, 1));
    await publisher().publish({ runId: run.id, stage: "COMPLETED", type: "run.completed", message: "Done", payload: { verdict: "PASSED" } });
    expect(await s.done).toBe(200);
    expect(s.events().map((e) => e.type)).toEqual(["step.recorded", "run.completed"]);
  });

  it("replays and closes for an already-terminal run", async () => {
    const run = await newRun();
    await publisher().publish(stageEvent(run.id, 1));
    await new RunRepository(t.tdb.db).transition(run.id, "QUEUED", "CANCELLED", { cancelReason: "USER_REQUESTED" });
    await publisher().publish({ runId: run.id, stage: "CANCELLED", type: "run.cancelled", message: "Cancelled", payload: { reason: "USER_REQUESTED" } });
    const s = openStream(run.id);
    expect(await s.done).toBe(200);
    expect(s.events().map((e) => e.sequence)).toEqual([1, 2]);
    // Reconnecting after the terminal event also closes immediately.
    await t.tdb.pool.query("UPDATE test_runs SET lifecycle_changed_at = now() - interval '1 minute' WHERE id = $1", [run.id]);
    const again = openStream(run.id, { headers: { "last-event-id": "2" } });
    expect(await again.done).toBe(200);
    expect(again.events()).toEqual([]);
  });

  it("returns 404 for another tenant's run and 401 without a token", async () => {
    const other = await newRun(OTHER_TENANT_ID);
    const s = openStream(other.id);
    expect(await s.done).toBe(404);
    const res = await fetch(`${base}/v1/test-runs/${other.id}/events`);
    expect(res.status).toBe(401);
  });
});

describe("SSE streams on shutdown", () => {
  it("app.close() ends open streams instead of waiting for them (clients reconnect with Last-Event-ID)", async () => {
    const own = await createTestApi({ sseHeartbeatMs: 60_000 });
    let stream: ReturnType<typeof openStream> | undefined;
    try {
      await own.app.listen({ port: 0, host: "127.0.0.1" });
      const addr = own.app.server.address();
      const ownBase = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
      const run = await new RunRepository(own.tdb.db).create({ tenantId: TEST_TENANT_ID, targetUrl: "https://x.com", request });
      await createRunEventPublisher({ events: new EventRepository(own.tdb.db), redis: own.redis, redact: (v) => v }).publish(
        stageEvent(run.id, 1),
      );

      const ac = new AbortController();
      const res = await fetch(`${ownBase}/v1/test-runs/${run.id}/events`, { headers: auth, signal: ac.signal });
      const reader = res.body!.getReader();
      let text = "";
      while (!text.includes("id: 1\n")) text += new TextDecoder().decode((await reader.read()).value);
      stream = { close: () => ac.abort() } as never;

      // The run is not terminal, so without the shutdown hook the stream (and close()) never ends.
      const closed = await Promise.race([
        own.app.close().then(() => "closed" as const),
        new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 3_000)),
      ]);
      expect(closed).toBe("closed");
      let ended = false;
      for (;;) {
        const { done } = await reader.read();
        if (done) {
          ended = true;
          break;
        }
      }
      expect(ended).toBe(true);
    } finally {
      stream?.close();
      await own.close();
    }
  });
});
