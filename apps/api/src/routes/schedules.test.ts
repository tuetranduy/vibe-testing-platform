import { RunRepository, ScheduleRepository, SuiteRunRepository, UserRepository } from "@platform/db";
import { TEST_TENANT_ID } from "@platform/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScheduleService, checkCron, nextFirings } from "../services/schedule-service";
import { FakeScheduleSync, auth, createTestApi, finishedRunWithTest, signInMember, type TestApi } from "../test-support";

const NOW = new Date("2026-09-30T08:00:00.000Z");
let t: TestApi;
let sync: FakeScheduleSync;
let admin: Awaited<ReturnType<typeof signInMember>>;
beforeAll(async () => {
  sync = new FakeScheduleSync();
  t = await createTestApi({}, { schedules: sync, now: () => NOW });
  admin = await signInMember(t, "admin");
});
afterAll(async () => t?.close());

type Method = "GET" | "POST" | "PUT" | "DELETE";
const call = (method: Method, url: string, payload?: object, headers: Record<string, string> = admin.headers) =>
  t.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });

let n = 0;
async function suiteWith(opts: { secrets?: Record<string, string>; profileSecrets?: Record<string, string>; headers?: Record<string, string> } = {}) {
  const headers = opts.headers ?? admin.headers;
  const profile = opts.profileSecrets
    ? (await call("POST", "/v1/credential-profiles", { name: `Schedule login ${++n}`, secrets: opts.profileSecrets })).json().id
    : null;
  const suite = (await call("POST", "/v1/suites", { name: `Scheduled ${++n}`, credentialProfileId: profile }, headers)).json();
  const source = await finishedRunWithTest(t, opts.secrets ? { secrets: opts.secrets } : {}, { headers });
  await call("POST", `/v1/suites/${suite.id}/entries`, { sourceRunId: source }, headers);
  return suite.id as string;
}

describe("checkCron", () => {
  it("accepts five-field expressions with enough time between runs, in a time zone", () => {
    expect(() => checkCron("0 9 * * 1-5", "Europe/Zurich", 15, NOW)).not.toThrow();
    expect(() => checkCron("*/15 * * * *", "UTC", 15, NOW)).not.toThrow();
    expect(() => checkCron("*/5 * * * *", "UTC", 15, NOW)).toThrow("Leave at least 15 minutes between two runs");
    expect(() => checkCron("0,5 9 * * *", "UTC", 15, NOW)).toThrow("Leave at least 15 minutes");
    expect(() => checkCron("0 61 * * *", "UTC", 15, NOW)).toThrow(/Not a valid schedule/);
    // NOW is 10:00 in Zurich (UTC+2): the next 09:00 there is tomorrow's.
    expect(nextFirings("0 9 * * *", "Europe/Zurich", NOW, 1)[0]!.toISOString()).toBe("2026-10-01T07:00:00.000Z");
    expect(nextFirings("0 11 * * *", "Europe/Zurich", NOW, 1)[0]!.toISOString()).toBe("2026-09-30T09:00:00.000Z");
  });
});

describe("/v1/suites/:suiteId/schedules (V1.2 F3)", () => {
  it("creates a schedule, mirrors it to a job scheduler and shows its next run", async () => {
    const suiteId = await suiteWith();
    const res = await call("POST", `/v1/suites/${suiteId}/schedules`, { cron: "0 9 * * *", timezone: "Europe/Zurich" });
    expect(res.statusCode).toBe(201);
    const schedule = res.json();
    // 09:00 in Zurich (UTC+2 in September) is 07:00 UTC, already past on NOW: the next one is tomorrow.
    expect(schedule).toMatchObject({ suiteId, cron: "0 9 * * *", timezone: "Europe/Zurich", enabled: true, nextRunAt: "2026-10-01T07:00:00.000Z", lastOutcome: null });
    expect(sync.schedulers.get(schedule.id)).toEqual({ cron: "0 9 * * *", timezone: "Europe/Zurich" });
    expect((await call("GET", `/v1/suites/${suiteId}/schedules`)).json().items.map((s: { id: string }) => s.id)).toEqual([schedule.id]);
    expect(t.audit.some((e) => e.action === "schedule.created" && e.scheduleId === schedule.id)).toBe(true);
  });

  it("refuses a bad or too frequent expression, an unknown time zone, and the service token", async () => {
    const suiteId = await suiteWith();
    expect((await call("POST", `/v1/suites/${suiteId}/schedules`, { cron: "*/5 * * * *" })).json().issues[0].path).toEqual(["cron"]);
    expect((await call("POST", `/v1/suites/${suiteId}/schedules`, { cron: "0 0 9 * * *" })).statusCode).toBe(400);
    expect((await call("POST", `/v1/suites/${suiteId}/schedules`, { cron: "0 9 * * *", timezone: "Mars/Olympus" })).statusCode).toBe(400);
    expect((await call("POST", `/v1/suites/${suiteId}/schedules`, { cron: "0 9 * * *" }, auth)).json().code).toBe("NO_SESSION");
  });

  it("refuses to enable a schedule while the suite's saved credentials miss a secret; a disabled one is kept", async () => {
    const suiteId = await suiteWith({ secrets: { password: "pw-long-enough" } });
    const refused = await call("POST", `/v1/suites/${suiteId}/schedules`, { cron: "0 9 * * *" });
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ code: "SECRETS_REQUIRED", issues: [{ path: ["secrets", "password"] }] });
    const disabled = (await call("POST", `/v1/suites/${suiteId}/schedules`, { cron: "0 9 * * *", enabled: false })).json();
    expect(disabled).toMatchObject({ enabled: false, nextRunAt: null });
    expect(sync.schedulers.has(disabled.id)).toBe(false);
  });

  it("disabling removes the job scheduler, deleting the schedule or its suite too", async () => {
    const suiteId = await suiteWith();
    const a = (await call("POST", `/v1/suites/${suiteId}/schedules`, { cron: "0 9 * * *" })).json();
    const b = (await call("POST", `/v1/suites/${suiteId}/schedules`, { cron: "0 18 * * *" })).json();
    expect((await call("PUT", `/v1/suite-schedules/${a.id}`, { cron: "0 9 * * *", enabled: false })).json().enabled).toBe(false);
    expect(sync.schedulers.has(a.id)).toBe(false);
    expect((await call("PUT", `/v1/suite-schedules/${a.id}`, { cron: "30 9 * * *" })).json()).toMatchObject({ enabled: true, cron: "30 9 * * *" });
    expect(sync.schedulers.get(a.id)?.cron).toBe("30 9 * * *");
    expect((await call("DELETE", `/v1/suite-schedules/${a.id}`)).statusCode).toBe(204);
    expect(sync.schedulers.has(a.id)).toBe(false);
    expect((await call("DELETE", `/v1/suites/${suiteId}`)).statusCode).toBe(204);
    expect(sync.schedulers.has(b.id)).toBe(false);
    expect(await new ScheduleRepository(t.tdb.db).findById(b.id)).toBeNull();
  });

  it("allows at most five schedules per suite, and hides another member's", async () => {
    const suiteId = await suiteWith();
    for (let i = 0; i < 5; i++) expect((await call("POST", `/v1/suites/${suiteId}/schedules`, { cron: `${i} 9 * * *` })).statusCode).toBe(201);
    expect((await call("POST", `/v1/suites/${suiteId}/schedules`, { cron: "30 9 * * *" })).json().code).toBe("SCHEDULE_LIMIT");
    const ann = await signInMember(t);
    expect((await call("GET", `/v1/suites/${suiteId}/schedules`, undefined, ann.headers)).statusCode).toBe(404);
    const id = (await call("GET", `/v1/suites/${suiteId}/schedules`)).json().items[0].id;
    expect((await call("DELETE", `/v1/suite-schedules/${id}`, undefined, ann.headers)).statusCode).toBe(404);
  });
});

describe("firing a schedule", () => {
  const service = () => new ScheduleService(t.deps);

  it("runs the suite as the schedule's creator with the suite's saved credentials, and skips while that run is going", async () => {
    const ann = await signInMember(t);
    const suiteId = await suiteWith({ headers: ann.headers });
    const schedule = (await call("POST", `/v1/suites/${suiteId}/schedules`, { cron: "0 9 * * *" }, ann.headers)).json();

    const fired = await service().fire(schedule.id);
    expect(fired).toMatchObject({ outcome: "started" });
    const suiteRun = await new SuiteRunRepository(t.tdb.db).findById(fired.suiteRunId!);
    expect(suiteRun).toMatchObject({ trigger: "schedule", scheduleId: schedule.id, ownerUserId: ann.userId });
    const view = (await call("GET", `/v1/suites/${suiteId}/schedules`, undefined, ann.headers)).json().items[0];
    expect(view).toMatchObject({ lastOutcome: "started", lastSuiteRunId: fired.suiteRunId, lastFiredAt: NOW.toISOString() });
    expect(t.audit.some((e) => e.action === "schedule.fired" && (e.detail as { scheduleId?: string })?.scheduleId === schedule.id)).toBe(true);

    expect(await service().fire(schedule.id)).toMatchObject({ outcome: "skipped_running" });
    // Once that run has finished, the next firing starts another.
    for (const child of await new SuiteRunRepository(t.tdb.db).children(fired.suiteRunId!)) {
      await new RunRepository(t.tdb.db).transition(child.id, "QUEUED", "CANCELLED", { cancelReason: "USER_REQUESTED" });
    }
    const later = new ScheduleService({ ...t.deps, now: () => new Date(NOW.getTime() + 86_400_000) });
    expect(await later.fire(schedule.id)).toMatchObject({ outcome: "started" });
  });

  it("skips a firing taken more than 15 minutes after it was due, and runs one that is on time (KI-037)", async () => {
    const ann = await signInMember(t);
    const suiteId = await suiteWith({ headers: ann.headers });
    const schedule = (await call("POST", `/v1/suites/${suiteId}/schedules`, { cron: "0 9 * * *" }, ann.headers)).json();

    const late = await service().fire(schedule.id, new Date(NOW.getTime() - 16 * 60_000));
    expect(late).toEqual({ outcome: "skipped_late" });
    const view = (await call("GET", `/v1/suites/${suiteId}/schedules`, undefined, ann.headers)).json().items[0];
    expect(view).toMatchObject({ lastOutcome: "skipped_late", lastSuiteRunId: null });
    expect(t.audit.some((e) => e.action === "schedule.skipped" && (e.detail as { scheduleId?: string })?.scheduleId === schedule.id)).toBe(true);

    expect(await service().fire(schedule.id, new Date(NOW.getTime() - 14 * 60_000))).toMatchObject({ outcome: "started" });
  });

  it("fails without starting when the creator is disabled or the saved credentials no longer cover the suite", async () => {
    const ann = await signInMember(t);
    const suiteId = await suiteWith({ headers: ann.headers });
    const schedule = (await call("POST", `/v1/suites/${suiteId}/schedules`, { cron: "0 9 * * *" }, ann.headers)).json();
    await new UserRepository(t.tdb.db).update(TEST_TENANT_ID, ann.userId, { disabledAt: new Date() });
    expect(await service().fire(schedule.id)).toMatchObject({ outcome: "failed", error: "OWNER_UNAVAILABLE" });

    const covered = await suiteWith({ secrets: { password: "pw-long-enough" }, profileSecrets: { password: "pw-long-enough" } });
    const s2 = (await call("POST", `/v1/suites/${covered}/schedules`, { cron: "0 9 * * *" })).json();
    await call("PUT", `/v1/suites/${covered}`, { name: `Uncovered ${++n}`, credentialProfileId: null });
    expect(await service().fire(s2.id)).toMatchObject({ outcome: "failed", error: "SECRETS_REQUIRED" });
  });

  it("ignores a disabled or deleted schedule and removes its stale job scheduler", async () => {
    await sync.upsert({ id: "sch_gone", cron: "0 9 * * *", timezone: "UTC" });
    expect(await service().fire("sch_gone")).toEqual({ outcome: "ignored" });
    expect(sync.schedulers.has("sch_gone")).toBe(false);
  });

  it("resync makes the job schedulers match the table", async () => {
    const suiteId = await suiteWith();
    const on = (await call("POST", `/v1/suites/${suiteId}/schedules`, { cron: "0 9 * * *" })).json();
    const off = (await call("POST", `/v1/suites/${suiteId}/schedules`, { cron: "0 10 * * *", enabled: false })).json();
    sync.schedulers.clear();
    await sync.upsert({ id: "sch_orphan", cron: "0 9 * * *", timezone: "UTC" });
    await service().resync();
    expect(sync.schedulers.has(on.id)).toBe(true);
    expect(sync.schedulers.has(off.id)).toBe(false);
    expect(sync.schedulers.has("sch_orphan")).toBe(false);
  });
});
