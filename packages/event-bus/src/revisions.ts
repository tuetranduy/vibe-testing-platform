import { randomUUID } from "node:crypto";
import type { AcceptanceCriterion, FactRequest } from "@platform/contracts";
import { Queue, QueueEvents, type ConnectionOptions } from "bullmq";
import { Redis } from "ioredis";

/**
 * Rewriting a check from the user's words (2026-11-19, plan 2026-11-19-rewrite-check-from-text). The API never calls a
 * model: it asks the worker on this queue of its own (a rewrite never waits behind a test run) and waits for the answer.
 * The job's return value is the proposal; accepting it later reads it back by its id, so what is saved is always what
 * the worker proposed, never criteria sent by a browser.
 */
export const REVISIONS_QUEUE = "revisions";
export const JOB_REVISE_CRITERION = "revise-criterion";
/** How long a proposal can still be accepted. */
export const PROPOSAL_TTL_SECONDS = 3_600;

export interface ReviseJobData {
  runId: string;
  criterionId: string;
  instruction: string;
  /** The requirement revision the proposal rewrites: accepting it needs that one to still be the latest. */
  basedOnRevision: number;
}

/** What the worker returns: the next revision's criteria and facts. */
export interface ProposalBody {
  runId: string;
  criterionId: string;
  basedOnRevision: number;
  criteria: AcceptanceCriterion[];
  facts: FactRequest[];
}

export interface CriterionProposal extends ProposalBody {
  /** The job's id: how the proposal is accepted. */
  proposalId: string;
}

/** The worker answered with an error; `code` is its prefix ("REVISE_NEEDS_MODEL: …"), else REVISE_FAILED. */
export class RevisionFailedError extends Error {
  override readonly name = "RevisionFailedError";
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/** No answer in time. */
export class RevisionTimeoutError extends Error {
  override readonly name = "RevisionTimeoutError";
}

export interface RevisionQueue {
  /** Queues the rewrite and waits for the proposal; RevisionFailedError / RevisionTimeoutError otherwise. */
  request(data: ReviseJobData, timeoutMs: number): Promise<CriterionProposal>;
  /** A finished proposal by its id; null when there is none (unknown, failed, expired). */
  proposal(proposalId: string): Promise<CriterionProposal | null>;
  close(): Promise<void>;
}

const CODE = /^([A-Z][A-Z_]+):\s*/;
/** How long cleanup and closing may take before they are given up on (a Redis that does not answer). */
const CLEANUP_MS = 2_000;

class Deadline extends Error {}

/** `work`, or a Deadline rejection after `ms` (the work keeps going; its outcome is ignored). */
function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Deadline()), Math.max(1, ms));
  });
  work.catch(() => {});
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

export function createRevisionQueue(connection: ConnectionOptions, opts: { now?: () => number } = {}): RevisionQueue {
  const now = opts.now ?? Date.now;
  const queue = new Queue<ReviseJobData, ProposalBody>(REVISIONS_QUEUE, { connection });
  // QueueEvents blocks on its connection: never the shared one.
  let events: QueueEvents | null = null;
  let own: Redis | null = null;
  const eventsOf = async () => {
    if (!events) {
      own = connection instanceof Redis ? connection.duplicate() : null;
      events = new QueueEvents(REVISIONS_QUEUE, { connection: own ?? connection });
      await events.waitUntilReady();
    }
    return events;
  };
  return {
    // One deadline for the whole request, Redis included: a Redis that does not answer must not hang it (review finding).
    async request(data, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      const left = () => deadline - Date.now();
      let job: Awaited<ReturnType<typeof queue.add>> | undefined;
      try {
        const listening = await within(eventsOf(), left());
        job = await within(
          queue.add(JOB_REVISE_CRITERION, data, {
            jobId: `${JOB_REVISE_CRITERION}__${data.runId}__${randomUUID()}`,
            attempts: 1,
            removeOnComplete: { age: PROPOSAL_TTL_SECONDS, count: 1000 },
            removeOnFail: { age: PROPOSAL_TTL_SECONDS, count: 1000 },
          }),
          left(),
        );
        const body = await within(job.waitUntilFinished(listening, Math.max(1, left())), left() + 100);
        return { ...body, proposalId: job.id! };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof Deadline || /timed out/i.test(message)) {
          if (job) await within(job.remove(), CLEANUP_MS).catch(() => {});
          throw new RevisionTimeoutError(`No answer to the rewrite in ${timeoutMs} ms`);
        }
        const code = CODE.exec(message)?.[1] ?? "REVISE_FAILED";
        throw new RevisionFailedError(code, message.replace(CODE, ""));
      }
    },
    async proposal(proposalId) {
      const job = await queue.getJob(proposalId);
      if (!job || job.name !== JOB_REVISE_CRITERION || !job.returnvalue || !(await job.isCompleted())) return null;
      // Removal of old jobs is lazy: an expired proposal can still be there (review finding).
      if (job.finishedOn === undefined || now() - job.finishedOn > PROPOSAL_TTL_SECONDS * 1000) return null;
      return { ...job.returnvalue, proposalId };
    },
    async close() {
      await within((events as QueueEvents | null)?.close() ?? Promise.resolve(), CLEANUP_MS).catch(() => {});
      (own as Redis | null)?.disconnect();
      await within(queue.close(), CLEANUP_MS).catch(() => {});
    },
  };
}
