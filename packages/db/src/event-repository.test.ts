import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventRepository } from "./event-repository";
import { RunRepository } from "./run-repository";
import { storedRequest } from "./test-helpers";
import { TEST_TENANT_ID, createTestDatabase, type TestDatabase } from "./testing";

let tdb: TestDatabase;
beforeAll(async () => {
  tdb = await createTestDatabase();
});
afterAll(async () => tdb?.drop());

describe("EventRepository", () => {
  it("allocates gap-free sequences 1..20 under concurrency", async () => {
    const run = await new RunRepository(tdb.db).create({
      tenantId: TEST_TENANT_ID,
      targetUrl: "https://x.com",
      request: storedRequest(),
    });
    const events = new EventRepository(tdb.db);
    const out = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        events.append({
          runId: run.id,
          stage: "QUEUED",
          type: "stage.started",
          message: `event ${i}`,
          payload: { stage: "QUEUED" },
        }),
      ),
    );
    expect(out.map((e) => e.sequence).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    const listed = await events.listAfter(run.id, 5, 100);
    expect(listed.map((e) => e.sequence)).toEqual(Array.from({ length: 15 }, (_, i) => i + 6));
    expect(await events.listAfter(run.id, 0, 3)).toHaveLength(3);
  });

  it("rejects an invalid event before persisting", async () => {
    const run = await new RunRepository(tdb.db).create({
      tenantId: TEST_TENANT_ID,
      targetUrl: "https://x.com",
      request: storedRequest(),
    });
    const events = new EventRepository(tdb.db);
    await expect(
      events.append({ runId: run.id, stage: "QUEUED", type: "criterion.evaluated", message: "x", payload: {} } as never),
    ).rejects.toThrow();
    expect(await events.listAfter(run.id, 0)).toHaveLength(0);
  });
});
