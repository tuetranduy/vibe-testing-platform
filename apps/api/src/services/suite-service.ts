import {
  AddSuiteEntryRequestSchema,
  ReorderSuiteEntriesRequestSchema,
  SuiteInputSchema,
  destructiveActionsAllowed,
  type SuiteDetail,
  type SuiteEntryView,
  type SuiteView,
} from "@platform/contracts";
import {
  CredentialProfileRepository,
  EntryExistsError,
  GeneratedTestRepository,
  NameTakenError,
  RunRepository,
  SuiteFullError,
  SuiteRepository,
  SuiteRunRepository,
  UserRepository,
  type SuiteRow,
  type SuiteRunRow,
  type TestRun,
} from "@platform/db";
import type { z } from "zod";
import { actorId, runScope, type Principal } from "../auth/principal";
import type { ApiDeps } from "../deps";
import { HttpError, zodIssues } from "../errors";
import { RerunService } from "./rerun-service";
import { ScheduleService } from "./schedule-service";

const notFound = () => new HttpError(404, "NOT_FOUND", "Not found");
const nameTaken = (err: NameTakenError) => new HttpError(409, "NAME_TAKEN", err.message, [{ path: ["name"], message: err.message }]);

export function parseBody<T>(schema: z.ZodType<T, unknown>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new HttpError(400, "VALIDATION_FAILED", "Request validation failed", zodIssues(r.error));
  return r.data;
}

/** The run a rerun came from, followed back to the run that generated the test (at most 20 hops). */
export async function rootSourceOf(runs: RunRepository, run: TestRun): Promise<TestRun> {
  let current = run;
  for (let i = 0; i < 20 && current.request.rerunOf; i++) {
    const parent = await runs.findById(current.request.rerunOf);
    if (!parent || parent.tenantId !== run.tenantId) break;
    current = parent;
  }
  return current;
}

export const suiteRunBrief = (r: SuiteRunRow) => ({
  id: r.id,
  trigger: r.trigger,
  status: r.status,
  verdict: r.verdict,
  createdAt: r.createdAt.toISOString(),
  finishedAt: r.finishedAt?.toISOString() ?? null,
});

/**
 * Suites (V1.2 F1): named lists of saved Playwright tests. A suite belongs to its creator: members see and manage
 * their own, administrators (and the service) every suite of the tenant — the same scope as runs, so a suite
 * never exposes a test its viewer could not open.
 */
export class SuiteService {
  private readonly suites: SuiteRepository;
  private readonly runs: RunRepository;

  constructor(private readonly deps: ApiDeps) {
    this.suites = new SuiteRepository(deps.db);
    this.runs = new RunRepository(deps.db);
  }

  async require(p: Principal, suiteId: string): Promise<SuiteRow> {
    const suite = await this.suites.find(runScope(p), suiteId);
    if (!suite) throw notFound();
    return suite;
  }

  private async views(tenantId: string, rows: SuiteRow[]): Promise<SuiteView[]> {
    const ids = rows.map((r) => r.id);
    const [counts, entries, latest, profiles, owners] = await Promise.all([
      this.suites.entryCounts(ids),
      this.suites.entriesOf(ids),
      new SuiteRunRepository(this.deps.db).latestFor(tenantId, ids),
      new CredentialProfileRepository(this.deps.db).list(tenantId),
      new UserRepository(this.deps.db).namesById(
        tenantId,
        rows.flatMap((r) => (r.ownerUserId ? [r.ownerUserId] : [])),
      ),
    ]);
    const sources = await this.runs.findByIds(
      tenantId,
      [...entries.values()].flat().map((e) => e.sourceRunId),
    );
    const profileById = new Map(profiles.map((p) => [p.id, p]));
    return rows.map((r) => {
      const secretNames = [
        ...new Set((entries.get(r.id) ?? []).flatMap((e) => sources.get(e.sourceRunId)?.request.secretNames ?? [])),
      ].sort();
      const profile = r.credentialProfileId ? profileById.get(r.credentialProfileId) : undefined;
      const provided = new Set(profile?.secretNames ?? []);
      const last = latest.get(r.id);
      return {
        id: r.id,
        name: r.name,
        description: r.description,
        credentialProfile: profile ? { id: profile.id, name: profile.name } : null,
        owner: r.ownerUserId ? { id: r.ownerUserId, name: owners.get(r.ownerUserId) ?? "Former user" } : null,
        entryCount: counts.get(r.id) ?? 0,
        secretNames,
        missingSecretNames: secretNames.filter((n) => !provided.has(n)),
        lastRun: last ? suiteRunBrief(last) : null,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      };
    });
  }

  async list(p: Principal, name?: string): Promise<SuiteView[]> {
    const rows = name !== undefined ? [await this.suites.findByName(runScope(p), name)].filter((r) => r !== null) : await this.suites.list(runScope(p));
    return this.views(p.tenantId, rows);
  }

  async detail(p: Principal, suiteId: string): Promise<SuiteDetail> {
    const suite = await this.require(p, suiteId);
    const [view] = await this.views(p.tenantId, [suite]);
    const entries = await this.suites.entries(suite.id);
    const [sources, last] = await Promise.all([
      this.runs.findByIds(p.tenantId, entries.map((e) => e.sourceRunId)),
      new SuiteRunRepository(this.deps.db).lastResultsBySource(p.tenantId, suite.id),
    ]);
    const tests = new GeneratedTestRepository(this.deps.db);
    const views: SuiteEntryView[] = [];
    for (const e of entries) {
      const source = sources.get(e.sourceRunId);
      if (!source) continue;
      const result = last.get(e.sourceRunId);
      views.push({
        sourceRunId: e.sourceRunId,
        position: e.position,
        title: source.request.requirement.slice(0, 200),
        targetUrl: source.targetUrl,
        environment: source.request.environment,
        secretNames: source.request.secretNames,
        destructive: destructiveActionsAllowed(source.request),
        compiledCriteria: (await tests.findByRun(source.id))?.compiledCriteria.length ?? 0,
        lastResult: result
          ? { runId: result.id, lifecycle: result.lifecycle, verdict: result.verdict, finishedAt: result.finishedAt?.toISOString() ?? null }
          : null,
        addedAt: e.addedAt.toISOString(),
      });
    }
    return { ...view!, entries: views };
  }

  private async checkProfile(tenantId: string, id: string | null): Promise<void> {
    if (id && !(await new CredentialProfileRepository(this.deps.db).find(tenantId, id))) {
      throw new HttpError(422, "CREDENTIAL_PROFILE_NOT_FOUND", "The saved credentials do not exist (they may have been deleted)", [
        { path: ["credentialProfileId"], message: "These saved credentials no longer exist" },
      ]);
    }
  }

  async create(p: Principal, body: unknown): Promise<SuiteDetail> {
    const input = parseBody(SuiteInputSchema, body);
    await this.checkProfile(p.tenantId, input.credentialProfileId);
    try {
      const row = await this.suites.create({ tenantId: p.tenantId, ...input, ownerUserId: actorId(p) });
      return this.detail(p, row.id);
    } catch (err) {
      if (err instanceof NameTakenError) throw nameTaken(err);
      throw err;
    }
  }

  async update(p: Principal, suiteId: string, body: unknown): Promise<SuiteDetail> {
    const input = parseBody(SuiteInputSchema, body);
    await this.checkProfile(p.tenantId, input.credentialProfileId);
    try {
      if (!(await this.suites.update(runScope(p), suiteId, input))) throw notFound();
    } catch (err) {
      if (err instanceof NameTakenError) throw nameTaken(err);
      throw err;
    }
    return this.detail(p, suiteId);
  }

  /** Its schedules go with it (their job schedulers first); its suite runs stay. */
  async remove(p: Principal, suiteId: string): Promise<void> {
    const suite = await this.require(p, suiteId);
    await new ScheduleService(this.deps).removeForSuite(suite.id);
    if (!(await this.suites.remove(runScope(p), suite.id))) throw notFound();
  }

  /**
   * Adds a finished run's saved test (a rerun adds the run that generated it: the same test). The caller must be
   * able to see the run; one that allowed destructive actions needs the confirmation, once, here.
   */
  async addEntry(p: Principal, suiteId: string, body: unknown): Promise<SuiteDetail> {
    const req = parseBody(AddSuiteEntryRequestSchema, body);
    const suite = await this.require(p, suiteId);
    const run = await this.runs.getRequired(runScope(p), req.sourceRunId);
    const source = await rootSourceOf(this.runs, run);
    await new RerunService(this.deps).savedTestOf(source);
    const destructive = destructiveActionsAllowed(source.request);
    if (destructive && req.confirmDestructiveActions !== true) {
      throw new HttpError(422, "CONFIRMATION_REQUIRED", "This test allowed destructive actions: confirm that every run of the suite repeats them", [
        {
          path: ["confirmDestructiveActions"],
          message: "Every run of the suite repeats the actions the test recorded, destructive ones included: confirm it",
        },
      ]);
    }
    try {
      await this.suites.addEntry(suite.id, { sourceRunId: source.id, confirmDestructive: destructive, addedBy: actorId(p) });
    } catch (err) {
      if (err instanceof SuiteFullError) throw new HttpError(409, "SUITE_FULL", err.message);
      if (err instanceof EntryExistsError) throw new HttpError(409, "ENTRY_EXISTS", err.message);
      throw err;
    }
    return this.detail(p, suite.id);
  }

  async removeEntry(p: Principal, suiteId: string, sourceRunId: string): Promise<void> {
    const suite = await this.require(p, suiteId);
    if (!(await this.suites.removeEntry(suite.id, sourceRunId))) throw notFound();
  }

  async reorder(p: Principal, suiteId: string, body: unknown): Promise<SuiteDetail> {
    const req = parseBody(ReorderSuiteEntriesRequestSchema, body);
    const suite = await this.require(p, suiteId);
    if (!(await this.suites.reorder(suite.id, req.sourceRunIds))) {
      throw new HttpError(400, "VALIDATION_FAILED", "Request validation failed", [
        { path: ["sourceRunIds"], message: "Name every test of the suite exactly once" },
      ]);
    }
    return this.detail(p, suite.id);
  }
}
