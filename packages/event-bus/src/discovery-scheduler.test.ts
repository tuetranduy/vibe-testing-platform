import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { admitDiscoveryRun, releaseDiscoverySlot, type SchedulerRedis } from "./discovery-scheduler";

const REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6379/13";
// Two connections stand in for two worker replicas sharing the scheduler.
let replicaA: Redis;
let replicaB: Redis;
beforeAll(() => {
  replicaA = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  replicaB = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
});
beforeEach(async () => {
  const keys = await replicaA.keys("browser-use:sched:*");
  if (keys.length) await replicaA.del(...keys);
});
afterAll(async () => {
  const keys = await replicaA.keys("browser-use:sched:*");
  if (keys.length) await replicaA.del(...keys);
  replicaA.disconnect();
  replicaB.disconnect();
});

const options = (overrides: Partial<Parameters<typeof admitDiscoveryRun>[3]> = {}) => ({
  capacity: 1, maxWaitMs: 5_000, leaseMs: 60_000, pollMs: 10, signal: new AbortController().signal, ...overrides,
});
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("fair Browser Use admission", () => {
  it("bounds concurrent leases across replicas and hands the slot on when released", async () => {
    const first = await admitDiscoveryRun(replicaA, "t_a", "run_1", options({ capacity: 1 }));
    expect(first.granted).toBe(true);
    const blocked = await admitDiscoveryRun(replicaB, "t_b", "run_2", options({ capacity: 1, maxWaitMs: 50 }));
    expect(blocked).toMatchObject({ granted: false });
    const waiting = admitDiscoveryRun(replicaB, "t_b", "run_2", options({ capacity: 1 }));
    await pause(50);
    if (first.granted) await first.release();
    await expect(waiting).resolves.toMatchObject({ granted: true });
    // Two slots admit two runs at once, never three.
    await releaseDiscoverySlot(replicaA, "t_b", "run_2");
    const grants = await Promise.all(["run_x", "run_y", "run_z"].map((run, index) =>
      admitDiscoveryRun(index % 2 ? replicaB : replicaA, `t_${index}`, run, options({ capacity: 2, maxWaitMs: 100 }))));
    expect(grants.filter((grant) => grant.granted)).toHaveLength(2);
  });

  it("takes tenants in turn: a tenant with many queued runs does not go before another tenant's first run", async () => {
    const holder = await admitDiscoveryRun(replicaA, "t_hold", "run_hold", options());
    const order: string[] = [];
    const contenders: Promise<void>[] = [];
    const contend = (tenant: string, run: string, redis: SchedulerRedis) => {
      contenders.push(admitDiscoveryRun(redis, tenant, run, options({ maxWaitMs: 10_000 })).then(async (admission) => {
        if (!admission.granted) throw new Error(`${run} was not admitted`);
        order.push(run);
        await pause(15);
        await admission.release();
      }));
    };
    for (const run of ["a1", "a2", "a3", "a4"]) {
      contend("t_a", run, replicaA);
      await pause(20); // arrival order: every a-run is queued before b1
    }
    contend("t_b", "b1", replicaB);
    await pause(40);
    if (holder.granted) await holder.release();
    await Promise.all(contenders);
    expect(order).toEqual(["a1", "b1", "a2", "a3", "a4"]);
  });

  it("does not starve a tenant while another keeps submitting", async () => {
    const holder = await admitDiscoveryRun(replicaA, "t_hold", "run_hold", options());
    const order: string[] = [];
    let next = 0;
    let stop = false;
    const busy = async () => {
      while (!stop) {
        const run = `busy_${next++}`;
        const admission = await admitDiscoveryRun(replicaA, "t_busy", run, options({ maxWaitMs: 10_000 }));
        if (!admission.granted) continue;
        order.push(run);
        await pause(10);
        await admission.release();
      }
    };
    const workers = [busy(), busy(), busy()];
    await pause(30);
    const quiet = admitDiscoveryRun(replicaB, "t_quiet", "quiet_1", options({ maxWaitMs: 10_000 })).then(async (admission) => {
      order.push("quiet_1");
      if (admission.granted) await admission.release();
    });
    await pause(30);
    if (holder.granted) await holder.release();
    await quiet;
    stop = true;
    await Promise.all(workers);
    // The quiet tenant's run is admitted within one rotation of the busy tenant.
    expect(order.indexOf("quiet_1")).toBeLessThanOrEqual(1);
  });

  it("is idempotent for a run that already holds its lease", async () => {
    const first = await admitDiscoveryRun(replicaA, "t_a", "run_same", options());
    const again = await admitDiscoveryRun(replicaB, "t_a", "run_same", options({ maxWaitMs: 0 }));
    expect([first.granted, again.granted]).toEqual([true, true]);
    expect(await replicaA.zcard("browser-use:sched:leases")).toBe(1);
  });

  it("removes a cancelled waiter, so the queue does not wait on it", async () => {
    const holder = await admitDiscoveryRun(replicaA, "t_hold", "run_hold", options());
    const controller = new AbortController();
    const cancelled = admitDiscoveryRun(replicaA, "t_a", "run_cancelled", options({ signal: controller.signal }));
    await pause(30);
    controller.abort(new Error("run cancelled"));
    await expect(cancelled).rejects.toThrow("run cancelled");
    expect(await replicaA.lrange("browser-use:sched:q:t_a", 0, -1)).toEqual([]);
    const next = admitDiscoveryRun(replicaB, "t_b", "run_next", options());
    await pause(30);
    if (holder.granted) await holder.release();
    await expect(next).resolves.toMatchObject({ granted: true });
  });

  it("recovers from a crashed holder (lease expiry) and a crashed waiter (waiter expiry)", async () => {
    // A holder whose worker died: its lease ends by itself after the job's budget.
    const crashedHolder = await admitDiscoveryRun(replicaA, "t_dead", "run_dead_holder", options({ leaseMs: 150 }));
    expect(crashedHolder.granted).toBe(true);
    // A waiter whose worker died before it could clean up: its registration expires.
    const noCleanup: SchedulerRedis = {
      eval: ((...args: Parameters<Redis["eval"]>) =>
        args[1] === 3 ? Promise.resolve(1) : replicaA.eval(...args)) as Redis["eval"], // RELEASE takes 3 keys: dropped
    };
    await admitDiscoveryRun(noCleanup, "t_dead", "run_dead_waiter", options({ maxWaitMs: 0, waiterTtlMs: 100 }));
    expect(await replicaA.lrange("browser-use:sched:q:t_dead", 0, -1)).toEqual(["run_dead_waiter"]);
    const survivor = await admitDiscoveryRun(replicaB, "t_dead", "run_live", options({ maxWaitMs: 2_000 }));
    expect(survivor).toMatchObject({ granted: true });
    expect(survivor.waitedMs).toBeGreaterThanOrEqual(100);
    expect(await replicaA.lrange("browser-use:sched:q:t_dead", 0, -1)).toEqual([]);
  });
});
