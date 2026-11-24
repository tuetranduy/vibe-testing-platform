import type { Redis } from "ioredis";

/**
 * Fair admission to the Browser Use broker's job slots, shared by every worker replica through Redis.
 *
 * - Bounded capacity: at most `capacity` leases exist at once (set it to the broker's total job slots).
 * - Fairness: tenants with waiting runs take turns (round robin); a tenant's own runs go first in, first out.
 *   A tenant that keeps submitting cannot starve another: the other tenant is next within one rotation.
 * - Recovery: a lease ends on release, or by itself after the job's whole budget plus a grace period (a crashed
 *   worker's broker job is over by then). A waiter that stops polling (its worker died) expires after
 *   `waiterTtlMs` and is skipped. No background process is needed.
 * - Idempotency: a run that already holds a lease gets it again; a run waits in at most one place.
 */
const PREFIX = "browser-use:sched";
const RING = `${PREFIX}:ring`;
const LEASES = `${PREFIX}:leases`;
const queueKey = (tenantId: string) => `${PREFIX}:q:${tenantId}`;
const waiterKey = (runId: string) => `${PREFIX}:w:${runId}`;

// KEYS: ring, leases, queue(tenant), waiter(run). ARGV: runId, tenantId, nowMs, leaseUntilMs, waiterTtlMs, capacity,
// prefix. Returns 1 when the run holds a lease, 0 while it waits its turn.
const ACQUIRE = `
local ring, leases, queue, waiter = KEYS[1], KEYS[2], KEYS[3], KEYS[4]
local runId, tenant, now, leaseUntil, waiterTtl, capacity, prefix =
  ARGV[1], ARGV[2], tonumber(ARGV[3]), ARGV[4], ARGV[5], tonumber(ARGV[6]), ARGV[7]
if redis.call('ZSCORE', leases, runId) then return 1 end
redis.call('ZREMRANGEBYSCORE', leases, '-inf', now)
redis.call('SET', waiter, tenant, 'PX', waiterTtl)
if not redis.call('LPOS', queue, runId) then redis.call('RPUSH', queue, runId) end
if not redis.call('LPOS', ring, tenant) then redis.call('RPUSH', ring, tenant) end
if redis.call('ZCARD', leases) >= capacity then return 0 end
for _ = 1, redis.call('LLEN', ring) do
  local t = redis.call('LINDEX', ring, 0)
  if not t then return 0 end
  local q = prefix .. ':q:' .. t
  local head = redis.call('LINDEX', q, 0)
  while head and redis.call('EXISTS', prefix .. ':w:' .. head) == 0 do
    redis.call('LPOP', q)
    head = redis.call('LINDEX', q, 0)
  end
  if not head then
    redis.call('LREM', ring, 1, t)
  elseif head == runId then
    redis.call('LPOP', q)
    redis.call('DEL', waiter)
    redis.call('ZADD', leases, leaseUntil, runId)
    redis.call('LREM', ring, 1, t)
    if redis.call('LLEN', q) > 0 then redis.call('RPUSH', ring, t) end
    return 1
  else
    return 0
  end
end
return 0
`;

// KEYS: leases, queue(tenant), waiter(run). ARGV: runId. Ends a lease or a wait. Idempotent.
const RELEASE = `
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('LREM', KEYS[2], 0, ARGV[1])
redis.call('DEL', KEYS[3])
return 1
`;

export type SchedulerRedis = Pick<Redis, "eval">;

export interface AdmissionOptions {
  capacity: number;
  /** How long the run may wait for its turn. */
  maxWaitMs: number;
  /** The lease's own end: the job's whole budget plus a grace period. */
  leaseMs: number;
  signal: AbortSignal;
  pollMs?: number;
  waiterTtlMs?: number;
  now?: () => number;
}

export type Admission = { granted: true; waitedMs: number; release(): Promise<void> } | { granted: false; waitedMs: number };

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

export async function releaseDiscoverySlot(redis: SchedulerRedis, tenantId: string, runId: string): Promise<void> {
  await redis.eval(RELEASE, 3, LEASES, queueKey(tenantId), waiterKey(runId), runId);
}

/**
 * Waits (polling) for a fair turn at a broker slot. Resolves `granted: false` when `maxWaitMs` passes first; rejects
 * when `signal` aborts (the run was cancelled), after removing the run from the queue. Redis errors reject.
 */
export async function admitDiscoveryRun(
  redis: SchedulerRedis, tenantId: string, runId: string, options: AdmissionOptions,
): Promise<Admission> {
  const now = options.now ?? Date.now;
  const started = now();
  const pollMs = options.pollMs ?? 250;
  const waiterTtlMs = options.waiterTtlMs ?? Math.max(5_000, pollMs * 20);
  const release = () => releaseDiscoverySlot(redis, tenantId, runId);
  try {
    for (;;) {
      options.signal.throwIfAborted();
      const at = now();
      const granted = await redis.eval(
        ACQUIRE, 4, RING, LEASES, queueKey(tenantId), waiterKey(runId),
        runId, tenantId, at, at + options.leaseMs, waiterTtlMs, options.capacity, PREFIX,
      );
      if (granted === 1) return { granted: true, waitedMs: at - started, release };
      if (at - started >= options.maxWaitMs) {
        await release();
        return { granted: false, waitedMs: at - started };
      }
      await sleep(Math.min(pollMs, Math.max(1, options.maxWaitMs - (at - started))), options.signal);
    }
  } catch (error) {
    await release().catch(() => {});
    throw error;
  }
}
