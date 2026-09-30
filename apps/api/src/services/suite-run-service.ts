import {
  CiContextSchema,
  RunSuiteRequestSchema,
  isTerminalLifecycle,
  suiteRunCounts,
  type RunSuiteResponse,
  type StoredTestRunRequest,
  type SuiteRunTrigger,
  type SuiteRunView,
} from "@platform/contracts";
import {
  RequirementRepository,
  ResultRepository,
  RunRepository,
  SuiteRepository,
  SuiteRunRepository,
  UserRepository,
  newId,
  type RunScope,
  type SuiteRunRow,
  type TestRun,
} from "@platform/db";
import { createRunRedactor } from "@platform/security";
import { createHmac } from "node:crypto";
import { z } from "zod";
import { renderJunit, type JunitChild } from "@platform/testing-engine/reporting";
import { actorId, runScope, type Principal } from "../auth/principal";
import type { ApiDeps } from "../deps";
import { HttpError } from "../errors";
import { ComparisonService } from "./comparison-service";
import { CredentialProfileService } from "./credential-profile-service";
import { RerunService, secretsRequired, type CreatedRun, type SavedTest } from "./rerun-service";
import { parseBody, suiteRunBrief, SuiteService } from "./suite-service";
import { TestRunService, canonical, isUniqueViolation } from "./test-run-service";

export interface StartSuiteRunOptions {
  trigger: SuiteRunTrigger;
  scheduleId?: string;
  /** Shown on the suite run (CI metadata, the token that started it); never trusted. */
  context?: Record<string, unknown>;
}

/**
 * Suite runs (V1.2 F1): one rerun of each entry's saved test, as its own run (`kind: rerun`, no model call),
 * created together in one transaction. The suite run takes one active-run slot, whatever its size; its children
 * are queued with a priority, so a large suite does not hold up runs queued after it (KI-038).
 */
export class SuiteRunService {
  private readonly suiteRuns: SuiteRunRepository;
  private readonly runs: RunRepository;
  private readonly reruns: RerunService;

  constructor(private readonly deps: ApiDeps) {
    this.suiteRuns = new SuiteRunRepository(deps.db);
    this.runs = new RunRepository(deps.db);
    this.reruns = new RerunService(deps);
  }

  async start(
    principal: Principal,
    suiteId: string,
    body: unknown,
    idempotencyKey: string | undefined,
    opts: StartSuiteRunOptions = { trigger: "manual" },
  ): Promise<{ status: 202; body: RunSuiteResponse; credentialProfileIds: string[] }> {
    const req = parseBody(RunSuiteRequestSchema, body);
    const { tenantId } = principal;
    const suite = await new SuiteService(this.deps).require(principal, suiteId);
    const entries = await new SuiteRepository(this.deps.db).entries(suite.id);
    if (entries.length === 0) throw new HttpError(409, "SUITE_EMPTY", "Add a test to the suite before running it");

    const sources = await this.runs.findByIds(tenantId, entries.map((e) => e.sourceRunId));
    const tests: { source: TestRun; saved: SavedTest }[] = [];
    for (const e of entries) {
      const source = sources.get(e.sourceRunId);
      if (!source) continue;
      tests.push({ source, saved: await this.reruns.savedTestOf(source) });
    }

    // Secrets: the request's own, over the request's saved credentials, over the suite's.
    const profiles = new CredentialProfileService(this.deps);
    const used: { id: string; name: string }[] = [];
    let given: Record<string, string> = {};
    for (const id of [suite.credentialProfileId, req.credentialProfileId]) {
      if (!id) continue;
      const profile = await profiles.secretsFor(tenantId, id);
      given = { ...given, ...profile.secrets };
      used.push(profile.ref);
    }
    given = { ...given, ...req.secrets };
    const needed = [...new Set(tests.flatMap((t) => t.source.request.secretNames))].sort();
    const missing = needed.filter((n) => !Object.hasOwn(given, n));
    if (missing.length > 0) throw secretsRequired(missing, "for this run: the suite's saved credentials don't provide it");
    const credentialProfile: StoredTestRunRequest["credentialProfile"] = used.at(-1);

    const requestHash = idempotencyKey
      ? createHmac("sha256", this.deps.config.secretsKey)
          // HMAC, not a plain hash: the body contains secrets.
          .update(canonical({ suite: suite.id, ...req }))
          .digest("hex")
      : null;
    if (idempotencyKey) {
      if (idempotencyKey.length > 200) throw new HttpError(400, "VALIDATION_FAILED", "Idempotency-Key too long");
      const existing = await this.suiteRuns.findByIdempotencyKey(tenantId, idempotencyKey);
      if (existing) return this.replay(existing, requestHash!, principal);
    }

    for (const [i, t] of tests.entries()) await this.reruns.checkTarget(t.source.targetUrl, ["entries", i, "targetUrl"]);

    const create = new TestRunService(this.deps);
    const publisher = create.publisher(createRunRedactor(needed.map((n) => given[n]!)));
    let created: { suiteRun: SuiteRunRow; runs: CreatedRun[] };
    try {
      created = await this.deps.db.transaction(async (tx) => {
        const txRuns = new RunRepository(tx);
        await txRuns.lockTenant(tenantId);
        if ((await txRuns.countActive(tenantId)) >= this.deps.config.maxActiveRunsPerTenant) {
          throw new HttpError(429, "TOO_MANY_ACTIVE_RUNS", "Too many active runs; wait for one to finish");
        }
        const suiteRun = await new SuiteRunRepository(tx).create({
          tenantId,
          suiteId: suite.id,
          suiteName: suite.name,
          trigger: opts.trigger,
          scheduleId: opts.scheduleId ?? null,
          ownerUserId: actorId(principal),
          context: { ...opts.context, ...(req.context ? { ci: req.context } : {}) },
          idempotencyKey: idempotencyKey ?? null,
          requestHash,
        });
        const runs: CreatedRun[] = [];
        for (const { source, saved } of tests) {
          const secrets = Object.fromEntries(source.request.secretNames.map((n) => [n, given[n]!]));
          runs.push(
            await this.reruns.insert(tx, {
              runId: newId("run"),
              tenantId,
              source,
              saved,
              stored: this.reruns.rerunRequest(source, secrets, source.request.secretNames.length > 0 ? credentialProfile : undefined),
              secrets,
              ownerUserId: actorId(principal),
              publisher,
              suiteRunId: suiteRun.id,
            }),
          );
        }
        return { suiteRun, runs };
      });
    } catch (err) {
      if (idempotencyKey && isUniqueViolation(err)) {
        const existing = await this.suiteRuns.findByIdempotencyKey(tenantId, idempotencyKey);
        if (existing) return this.replay(existing, requestHash!, principal);
        throw new HttpError(409, "IDEMPOTENCY_CONFLICT", "A request with this Idempotency-Key is being processed");
      }
      throw err;
    }

    // In entry order, each behind single runs and taking turns with other suites (KI-038). A child that cannot be
    // queued is errored on its own (QUEUE_UNAVAILABLE); the others go on.
    for (const [position, c] of created.runs.entries()) {
      await publisher.notify(c.event);
      await this.reruns.enqueue(c.run, position);
    }
    await this.suiteRuns.settle(created.suiteRun.id);
    return {
      status: 202,
      body: { suiteRunId: created.suiteRun.id, runIds: created.runs.map((c) => c.run.id) },
      credentialProfileIds: used.map((u) => u.id),
    };
  }

  private async replay(existing: SuiteRunRow, requestHash: string, principal: Principal) {
    if (existing.requestHash !== requestHash || existing.ownerUserId !== actorId(principal)) {
      throw new HttpError(409, "IDEMPOTENCY_CONFLICT", "This Idempotency-Key was used for a different request");
    }
    const children = await this.suiteRuns.children(existing.id);
    return { status: 202 as const, body: { suiteRunId: existing.id, runIds: children.map((c) => c.id) }, credentialProfileIds: [] };
  }

  async require(p: Principal, suiteRunId: string): Promise<SuiteRunRow> {
    const found = await this.suiteRuns.find(runScope(p), suiteRunId);
    if (!found) throw new HttpError(404, "NOT_FOUND", "Not found");
    return found;
  }

  async get(p: Principal, suiteRunId: string): Promise<SuiteRunView> {
    let row = await this.require(p, suiteRunId);
    // Settled on read too, so a result is never shown RUNNING after its last child ended.
    if (row.status === "RUNNING") row = (await this.suiteRuns.settle(row.id)) ?? row;
    return this.view(row, runScope(p));
  }

  async view(row: SuiteRunRow, scope: RunScope = { tenantId: row.tenantId }): Promise<SuiteRunView> {
    const children = await this.suiteRuns.children(row.id);
    const changes = await new ComparisonService(this.deps).changesOf(scope, children);
    const owner = row.ownerUserId ? await new UserRepository(this.deps.db).namesById(row.tenantId, [row.ownerUserId]) : new Map<string, string>();
    return {
      ...suiteRunBrief(row),
      suiteId: row.suiteId,
      suiteName: row.suiteName,
      owner: row.ownerUserId ? { id: row.ownerUserId, name: owner.get(row.ownerUserId) ?? "Former user" } : null,
      ci: CiContextSchema.nullable().catch(null).parse(row.context.ci ?? null),
      startedWithToken: z.object({ id: z.string(), name: z.string() }).nullable().catch(null).parse(row.context.token ?? null),
      counts: suiteRunCounts(children),
      changes: {
        regressed: [...changes.values()].filter((c) => c.change === "regressed").length,
        fixed: [...changes.values()].filter((c) => c.change === "fixed").length,
      },
      children: children.map((c) => ({
        change: changes.get(c.id)?.change ?? null,
        baselineRunId: changes.get(c.id)?.baselineRunId ?? null,
        runId: c.id,
        sourceRunId: c.request.rerunOf ?? c.id,
        title: c.request.requirement.slice(0, 200),
        targetUrl: c.targetUrl,
        lifecycle: c.lifecycle,
        verdict: c.verdict,
        finishedAt: c.finishedAt?.toISOString() ?? null,
      })),
    };
  }

  async listForSuite(p: Principal, suiteId: string, limit: number) {
    const suite = await new SuiteService(this.deps).require(p, suiteId);
    return { items: (await this.suiteRuns.listForSuite(runScope(p), suite.id, limit)).map(suiteRunBrief) };
  }

  /**
   * A settled suite run as JUnit XML (V1.2 F5): each child's criteria with their wording, status, expected and
   * actual values. `409 SUITE_RUN_NOT_FINISHED` while it is going.
   */
  async junit(p: Principal, suiteRunId: string): Promise<string> {
    let row = await this.require(p, suiteRunId);
    if (row.status === "RUNNING") row = (await this.suiteRuns.settle(row.id)) ?? row;
    if (row.status !== "COMPLETED") throw new HttpError(409, "SUITE_RUN_NOT_FINISHED", "The JUnit report is available once every test has finished");
    const children: JunitChild[] = [];
    for (const c of await this.suiteRuns.children(row.id)) {
      const [results, requirement] = await Promise.all([
        new ResultRepository(this.deps.db).listByRun(c.id),
        new RequirementRepository(this.deps.db).findLatest(c.id),
      ]);
      const statements = new Map((requirement?.criteria ?? []).map((x) => [x.id, x.statement]));
      children.push({
        runId: c.id,
        title: c.request.requirement.slice(0, 200),
        lifecycle: c.lifecycle,
        durationMs: c.startedAt && c.finishedAt ? c.finishedAt.getTime() - c.startedAt.getTime() : null,
        error: c.errorCategory ? { category: c.errorCategory, message: c.errorMessage } : null,
        criteria: results.map((r) => ({
          id: r.criterionId,
          description: statements.get(r.criterionId) ?? r.criterionId,
          critical: "critical" in r ? r.critical !== false : true,
          status: r.status,
          expected: r.expected,
          actual: r.actual,
          reason: r.reason,
        })),
      });
    }
    return renderJunit({ suiteName: row.suiteName, suiteRunId: row.id, children });
  }

  /** Cancels every child still active (each like `POST /v1/test-runs/:id/cancel`); the suite run settles once they end. */
  async cancel(p: Principal, suiteRunId: string): Promise<SuiteRunView> {
    const row = await this.require(p, suiteRunId);
    if (row.status === "COMPLETED") throw new HttpError(409, "RUN_TERMINAL", "This suite run has already finished");
    const runs = new TestRunService(this.deps);
    for (const child of await this.suiteRuns.children(row.id)) {
      if (isTerminalLifecycle(child.lifecycle)) continue;
      try {
        await runs.cancel(p, child.id);
      } catch (err) {
        if (!(err instanceof HttpError && err.code === "RUN_TERMINAL")) throw err;
      }
    }
    return this.get(p, row.id);
  }
}
