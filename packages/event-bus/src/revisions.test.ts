import { createServer, type AddressInfo } from "node:net";
import { Queue, Worker, UnrecoverableError } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REVISIONS_QUEUE, RevisionFailedError, RevisionTimeoutError, createRevisionQueue, type ReviseJobData, type RevisionQueue } from "./revisions";

const REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6379/15";
let connection: Redis;
let revisions: RevisionQueue;
beforeAll(async () => {
  connection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  const queue = new Queue(REVISIONS_QUEUE, { connection });
  await queue.obliterate({ force: true });
  await queue.close();
  revisions = createRevisionQueue(connection);
});
afterAll(async () => {
  await revisions?.close();
  connection?.disconnect();
});

const data: ReviseJobData = { runId: "run_1", criterionId: "AC-1", instruction: "the price is in euros", basedOnRevision: 2 };
const answer = { criteria: [{ id: "AC-1" }], facts: [] };

describe("createRevisionQueue (2026-11-19)", () => {
  it("a worker's answer comes back as the proposal, and can be read again by its id", async () => {
    const worker = new Worker<ReviseJobData>(REVISIONS_QUEUE, async (job) => ({ ...job.data, ...answer }), { connection });
    try {
      const proposal = await revisions.request(data, 10_000);
      expect(proposal).toMatchObject({ runId: "run_1", criterionId: "AC-1", basedOnRevision: 2, criteria: [{ id: "AC-1" }], facts: [] });
      expect(proposal.proposalId).toMatch(/^revise-criterion__run_1__/);
      expect(await revisions.proposal(proposal.proposalId)).toEqual(proposal);
      expect(await revisions.proposal("revise-criterion__run_1__nope")).toBeNull();
    } finally {
      await worker.close();
    }
  });

  it("a job that fails with a code: RevisionFailedError carrying it", async () => {
    const worker = new Worker<ReviseJobData>(REVISIONS_QUEUE, async () => {
      throw new UnrecoverableError("REVISE_NEEDS_MODEL: the fake engine has no model");
    }, { connection });
    try {
      const err = await revisions.request(data, 10_000).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RevisionFailedError);
      expect((err as RevisionFailedError).code).toBe("REVISE_NEEDS_MODEL");
    } finally {
      await worker.close();
    }
  });

  it("a Redis that never answers: RevisionTimeoutError within the deadline, and close does not hang (review finding)", async () => {
    // Accepts the connection and never answers: every command waits forever.
    const silent = createServer((socket) => void socket.on("error", () => {}));
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const { port } = silent.address() as AddressInfo;
    const dead = new Redis(port, "127.0.0.1", { maxRetriesPerRequest: null });
    const stuck = createRevisionQueue(dead);
    try {
      const started = Date.now();
      await expect(stuck.request(data, 500)).rejects.toBeInstanceOf(RevisionTimeoutError);
      expect(Date.now() - started).toBeLessThan(3_000);
      const closing = Date.now();
      await stuck.close();
      expect(Date.now() - closing).toBeLessThan(6_000);
    } finally {
      dead.disconnect();
      silent.close();
    }
  });

  it("a proposal older than the TTL can no longer be read (review finding)", async () => {
    let now = Date.now();
    const aging = createRevisionQueue(connection, { now: () => now });
    const worker = new Worker<ReviseJobData>(REVISIONS_QUEUE, async (job) => ({ ...job.data, ...answer }), { connection });
    try {
      const proposal = await aging.request(data, 10_000);
      expect(await aging.proposal(proposal.proposalId)).not.toBeNull();
      now += 2 * 3_600_000;
      expect(await aging.proposal(proposal.proposalId)).toBeNull();
    } finally {
      await worker.close();
      await aging.close();
    }
  });

  it("no worker answers in time: RevisionTimeoutError", async () => {
    await expect(revisions.request(data, 300)).rejects.toBeInstanceOf(RevisionTimeoutError);
  });
});
