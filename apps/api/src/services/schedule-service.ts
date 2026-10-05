import {
  MAX_SCHEDULES_PER_SUITE,
  MAX_SCHEDULES_PER_TENANT,
  SCHEDULE_GRACE_MINUTES,
  ScheduleInputSchema,
  type ScheduleOutcome,
  type ScheduleView,
} from "@platform/contracts";
import { AuditRepository, ScheduleRepository, SuiteRunRepository, UserRepository, type ScheduleRow } from "@platform/db";
import { CronExpressionParser } from "cron-parser";
import type { Principal } from "../auth/principal";
import { actorId } from "../auth/principal";
import type { ApiDeps } from "../deps";
import { HttpError } from "../errors";
import { SuiteRunService } from "./suite-run-service";
import { SuiteService, parseBody } from "./suite-service";

/** The default least time between two firings of a schedule (SCHEDULE_MIN_INTERVAL_MINUTES). */
export const DEFAULT_SCHEDULE_MIN_INTERVAL_MINUTES = 15;
const CHECKED_FIRINGS = 20;

const notFound = () => new HttpError(404, "NOT_FOUND", "Not found");
const cronIssue = (message: string) => new HttpError(400, "VALIDATION_FAILED", message, [{ path: ["cron"], message }]);

/** The next `n` firing times after `from`, in `timezone`. Throws what cron-parser throws for a bad expression. */
export function nextFirings(cron: string, timezone: string, from: Date, n: number): Date[] {
  const it = CronExpressionParser.parse(cron, { currentDate: from, tz: timezone });
  return it.take(n).map((d) => d.toDate());
}

/**
 * A usable schedule: five fields cron-parser accepts, and at least `minMinutes` between any two of the next 20
 * firings (a schedule can never flood the workers).
 */
export function checkCron(cron: string, timezone: string, minMinutes: number, now: Date): void {
  let times: Date[];
  try {
    times = nextFirings(cron, timezone, now, CHECKED_FIRINGS);
  } catch (err) {
    throw cronIssue(`Not a valid schedule: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (times.length === 0) throw cronIssue("This schedule never fires");
  for (let i = 1; i < times.length; i++) {
    if (times[i]!.getTime() - times[i - 1]!.getTime() < minMinutes * 60_000) {
      throw cronIssue(`Leave at least ${minMinutes} minutes between two runs`);
    }
  }
}

/**
 * Suite schedules (V1.2 F3). The table is the truth: every change is mirrored to a BullMQ job scheduler
 * (`deps.schedules`), and the API resyncs them all when it starts. A firing runs the suite as the schedule's
 * creator, with the suite's saved credentials only.
 */
export class ScheduleService {
  private readonly repo: ScheduleRepository;

  constructor(private readonly deps: ApiDeps) {
    this.repo = new ScheduleRepository(deps.db);
  }

  private get minMinutes(): number {
    return this.deps.config.scheduleMinIntervalMinutes ?? DEFAULT_SCHEDULE_MIN_INTERVAL_MINUTES;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private async views(tenantId: string, rows: ScheduleRow[]): Promise<ScheduleView[]> {
    const names = await new UserRepository(this.deps.db).namesById(
      tenantId,
      rows.flatMap((r) => (r.createdBy ? [r.createdBy] : [])),
    );
    const now = this.now();
    return rows.map((r) => {
      let next: Date | null = null;
      if (r.enabled) {
        try {
          next = nextFirings(r.cron, r.timezone, now, 1)[0] ?? null;
        } catch {
          next = null;
        }
      }
      return {
        id: r.id,
        suiteId: r.suiteId,
        cron: r.cron,
        timezone: r.timezone,
        enabled: r.enabled,
        nextRunAt: next?.toISOString() ?? null,
        lastFiredAt: r.lastFiredAt?.toISOString() ?? null,
        lastOutcome: r.lastOutcome,
        lastError: r.lastError,
        lastSuiteRunId: r.lastSuiteRunId,
        createdBy: r.createdBy ? { id: r.createdBy, name: names.get(r.createdBy) ?? "Former user" } : null,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      };
    });
  }

  /** `422 SECRETS_REQUIRED` unless the suite's saved credentials provide every secret its tests use. */
  private async requireCovered(p: Principal, suiteId: string): Promise<void> {
    const { missingSecretNames: missing } = await new SuiteService(this.deps).detail(p, suiteId);
    if (missing.length > 0) {
      throw new HttpError(
        422,
        "SECRETS_REQUIRED",
        `A scheduled run can only use the suite's saved credentials, which don't provide ${missing.join(", ")}`,
        missing.map((n) => ({ path: ["secrets", n], message: `Add ${n} to the suite's saved credentials` })),
      );
    }
  }

  private async sync(row: ScheduleRow): Promise<void> {
    if (!this.deps.schedules) return;
    if (row.enabled) await this.deps.schedules.upsert(row);
    else await this.deps.schedules.remove(row.id);
  }

  async list(p: Principal, suiteId: string): Promise<ScheduleView[]> {
    const suite = await new SuiteService(this.deps).require(p, suiteId);
    return this.views(p.tenantId, await this.repo.listForSuite(suite.id));
  }

  async create(p: Principal, suiteId: string, body: unknown): Promise<ScheduleView> {
    // A schedule's runs belong to its creator: the service token has no user to run as.
    if (p.kind !== "user") throw new HttpError(400, "NO_SESSION", "A schedule runs as the user who creates it: sign in to create one");
    const input = parseBody(ScheduleInputSchema, body);
    const suite = await new SuiteService(this.deps).require(p, suiteId);
    checkCron(input.cron, input.timezone, this.minMinutes, this.now());
    const counts = await this.repo.counts(p.tenantId, suite.id);
    if (counts.suite >= MAX_SCHEDULES_PER_SUITE) throw new HttpError(409, "SCHEDULE_LIMIT", `A suite has at most ${MAX_SCHEDULES_PER_SUITE} schedules`);
    if (counts.tenant >= MAX_SCHEDULES_PER_TENANT) throw new HttpError(409, "SCHEDULE_LIMIT", `The workspace has at most ${MAX_SCHEDULES_PER_TENANT} schedules`);
    if (input.enabled) await this.requireCovered(p, suite.id);
    const row = await this.repo.create({ tenantId: p.tenantId, suiteId: suite.id, ...input, createdBy: actorId(p) });
    await this.sync(row);
    return (await this.views(p.tenantId, [row]))[0]!;
  }

  private async requireSchedule(p: Principal, scheduleId: string): Promise<ScheduleRow> {
    const row = await this.repo.find(p.tenantId, scheduleId);
    if (!row) throw notFound();
    // The schedule is as visible as its suite.
    await new SuiteService(this.deps).require(p, row.suiteId);
    return row;
  }

  async update(p: Principal, scheduleId: string, body: unknown): Promise<ScheduleView> {
    const input = parseBody(ScheduleInputSchema, body);
    const current = await this.requireSchedule(p, scheduleId);
    checkCron(input.cron, input.timezone, this.minMinutes, this.now());
    if (input.enabled) await this.requireCovered(p, current.suiteId);
    const row = await this.repo.update(p.tenantId, scheduleId, input);
    if (!row) throw notFound();
    await this.sync(row);
    return (await this.views(p.tenantId, [row]))[0]!;
  }

  async remove(p: Principal, scheduleId: string): Promise<void> {
    await this.requireSchedule(p, scheduleId);
    await this.repo.remove(p.tenantId, scheduleId);
    await this.deps.schedules?.remove(scheduleId);
  }

  /** Before a suite is deleted (its rows go with it, by cascade): its job schedulers. */
  async removeForSuite(suiteId: string): Promise<void> {
    for (const row of await this.repo.listForSuite(suiteId)) await this.deps.schedules?.remove(row.id);
  }

  /** Makes the job schedulers match the table: every enabled schedule has one, nothing else does. */
  async resync(): Promise<{ upserted: number; removed: number }> {
    if (!this.deps.schedules) return { upserted: 0, removed: 0 };
    const rows = await this.repo.listAll();
    const enabled = new Set<string>();
    for (const row of rows.filter((r) => r.enabled)) {
      await this.deps.schedules.upsert(row);
      enabled.add(row.id);
    }
    let removed = 0;
    for (const id of await this.deps.schedules.ids()) {
      if (enabled.has(id)) continue;
      await this.deps.schedules.remove(id);
      removed += 1;
    }
    return { upserted: enabled.size, removed };
  }

  /**
   * A firing: runs the suite as the schedule's creator, unless the schedule is gone or disabled (its stale job
   * scheduler is removed), its creator is gone or disabled, or its previous run is still going (skipped). Every
   * outcome is recorded on the schedule and in the audit log.
   */
  /**
   * One firing. `dueAt`: when the job scheduler meant it to run. A firing more than SCHEDULE_GRACE_MINUTES late —
   * the API was down when it was due, and BullMQ kept it — is skipped, not run hours later (KI-037).
   */
  async fire(
    scheduleId: string,
    dueAt?: Date,
  ): Promise<{ outcome: ScheduleOutcome | "ignored"; suiteRunId?: string; error?: string }> {
    const now = this.now();
    const row = await this.repo.findById(scheduleId);
    if (!row || !row.enabled) {
      await this.deps.schedules?.remove(scheduleId);
      return { outcome: "ignored" };
    }
    const record = async (outcome: ScheduleOutcome, detail: { error?: string; suiteRunId?: string } = {}) => {
      await this.repo.recordFiring(row.id, now, outcome, detail);
      const action = outcome === "started" ? "schedule.fired" : outcome === "failed" ? "schedule.failed" : "schedule.skipped";
      const entry = { tenantId: row.tenantId, userId: row.createdBy, action, detail: { scheduleId: row.id, suiteId: row.suiteId, ...detail } };
      this.deps.audit?.({ ...entry, at: now.toISOString() });
      await new AuditRepository(this.deps.db).append(entry).catch(() => {});
      return { outcome, ...detail };
    };

    if (dueAt && now.getTime() - dueAt.getTime() > SCHEDULE_GRACE_MINUTES * 60_000) return record("skipped_late");

    const creator = row.createdBy ? await new UserRepository(this.deps.db).findById(row.tenantId, row.createdBy) : null;
    if (!creator || creator.disabledAt) return record("failed", { error: "OWNER_UNAVAILABLE" });

    if (row.lastSuiteRunId) {
      const suiteRuns = new SuiteRunRepository(this.deps.db);
      const previous = await suiteRuns.findById(row.lastSuiteRunId);
      if (previous?.status === "RUNNING" && !(await suiteRuns.settle(previous.id))) return record("skipped_running");
    }

    const principal: Principal = {
      kind: "user",
      tenantId: row.tenantId,
      userId: creator.id,
      sessionId: `schedule:${row.id}`,
      role: creator.role,
      name: creator.name,
      email: creator.email,
    };
    try {
      // One suite run per firing, even if the job ran twice: the key names the schedule and the minute.
      const key = `schedule:${row.id}:${Math.floor(now.getTime() / 60_000)}`;
      const started = await new SuiteRunService(this.deps).start(principal, row.suiteId, {}, key, { trigger: "schedule", scheduleId: row.id });
      return record("started", { suiteRunId: started.body.suiteRunId });
    } catch (err) {
      if (err instanceof HttpError) return record("failed", { error: err.code });
      throw err;
    }
  }
}
