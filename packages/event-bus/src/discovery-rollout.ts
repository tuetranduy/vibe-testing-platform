import type { Redis } from "ioredis";

const key = (tenantId: string) => `browser-use:enabled:${tenantId}`;
const attemptsKey = (tenantId: string, hour: number) => `browser-use:attempts:${tenantId}:${hour}`;
const REDIS_TIMEOUT_MS = 1_000;

async function bounded<T>(work: Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), REDIS_TIMEOUT_MS); })]);
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

/** A missing flag or a Redis outage closes discovery admission. Existing survey jobs can continue. */
export async function discoveryEnabled(redis: Pick<Redis, "get"> | undefined, tenantId: string): Promise<boolean> {
  if (!redis) return false;
  return bounded(redis.get(key(tenantId)).then((value) => value === "1"), false);
}

export async function setDiscoveryEnabled(
  redis: Pick<Redis, "set" | "del">, tenantId: string, enabled: boolean,
): Promise<void> {
  if (enabled) await redis.set(key(tenantId), "1");
  else await redis.del(key(tenantId));
}

// INCR and its expiry in one step: a crash between them cannot leave a counter that never resets.
const RESERVE = `local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n`;

// Never below zero, and only within the counter's own hour.
const REFUND = `local n = tonumber(redis.call('GET', KEYS[1]) or '0')
if n > 0 then return redis.call('DECR', KEYS[1]) end
return 0`;

/** Returns one attempt to the tenant's hourly quota (a run that was never admitted to a broker slot). */
export async function refundDiscoveryAttempt(
  redis: Pick<Redis, "eval"> | undefined, tenantId: string, now = Date.now(),
): Promise<void> {
  if (!redis) return;
  await bounded(redis.eval(REFUND, 1, attemptsKey(tenantId, Math.floor(now / 3_600_000))) as Promise<unknown>, null);
}

/**
 * Claims one Browser Use attempt from the tenant's hourly quota, so one tenant cannot hold the single-job broker
 * for everyone else. Fails closed: without Redis, or over the limit, the run keeps its standard survey.
 */
export async function reserveDiscoveryAttempt(
  redis: Pick<Redis, "eval"> | undefined, tenantId: string, limitPerHour: number, now = Date.now(),
): Promise<boolean> {
  if (!redis) return false;
  const hour = Math.floor(now / 3_600_000);
  const count = await bounded(redis.eval(RESERVE, 1, attemptsKey(tenantId, hour), 2 * 3600) as Promise<unknown>, null);
  return typeof count === "number" && count <= limitPerHour;
}
