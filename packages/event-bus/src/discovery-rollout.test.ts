import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { discoveryEnabled, refundDiscoveryAttempt, reserveDiscoveryAttempt, setDiscoveryEnabled } from "./discovery-rollout";

const REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6379/15";
let redis: Redis;
const tenant = `t_rollout_${Date.now().toString(36)}`;
beforeAll(() => { redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null }); });
afterAll(async () => {
  const keys = await redis.keys(`browser-use:*:${tenant}*`);
  if (keys.length) await redis.del(...keys);
  redis.disconnect();
});

describe("Browser Use tenant rollout and quota", () => {
  it("is off until enabled, and off again after the rollback", async () => {
    expect(await discoveryEnabled(redis, tenant)).toBe(false);
    await setDiscoveryEnabled(redis, tenant, true);
    expect(await discoveryEnabled(redis, tenant)).toBe(true);
    await setDiscoveryEnabled(redis, tenant, false);
    expect(await discoveryEnabled(redis, tenant)).toBe(false);
    expect(await discoveryEnabled(undefined, tenant)).toBe(false);
  });

  it("admits attempts up to the tenant's hourly limit, separately per tenant and per hour, with an expiry", async () => {
    const hour = Date.UTC(2026, 10, 23, 10, 15);
    expect(await reserveDiscoveryAttempt(redis, tenant, 2, hour)).toBe(true);
    expect(await reserveDiscoveryAttempt(redis, tenant, 2, hour + 60_000)).toBe(true);
    expect(await reserveDiscoveryAttempt(redis, tenant, 2, hour + 120_000)).toBe(false);
    expect(await reserveDiscoveryAttempt(redis, `${tenant}_other`, 2, hour)).toBe(true);
    expect(await reserveDiscoveryAttempt(redis, tenant, 2, hour + 3_600_000)).toBe(true);
    const ttl = await redis.ttl(`browser-use:attempts:${tenant}:${Math.floor(hour / 3_600_000)}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(7200);
  });

  it("refunds an attempt that never reached a broker slot, never below zero", async () => {
    const hour = Date.UTC(2026, 10, 24, 9, 0);
    const t = `${tenant}_refund`;
    expect(await reserveDiscoveryAttempt(redis, t, 1, hour)).toBe(true);
    expect(await reserveDiscoveryAttempt(redis, t, 1, hour)).toBe(false);
    await refundDiscoveryAttempt(redis, t, hour);
    await refundDiscoveryAttempt(redis, t, hour);
    expect(await redis.get(`browser-use:attempts:${t}:${Math.floor(hour / 3_600_000)}`)).toBe("0");
    expect(await reserveDiscoveryAttempt(redis, t, 1, hour)).toBe(true);
    await refundDiscoveryAttempt(undefined, t, hour);
  });

  it("fails closed without Redis or when Redis errors", async () => {
    expect(await reserveDiscoveryAttempt(undefined, tenant, 5)).toBe(false);
    const broken = { eval: async () => { throw new Error("down"); } } as unknown as Pick<Redis, "eval">;
    expect(await reserveDiscoveryAttempt(broken, tenant, 5)).toBe(false);
    const broken2 = { get: async () => { throw new Error("down"); } } as unknown as Pick<Redis, "get">;
    expect(await discoveryEnabled(broken2, tenant)).toBe(false);
  });
});
