import {
  RerunRequestSchema,
  destructiveActionsAllowed,
  isTerminalLifecycle,
  type CreateTestRunResponse,
  type GeneratedTest,
  type NormalizedRequirement,
  type StoredTestRunRequest,
} from "@platform/contracts";
import {
  EventRepository,
  GeneratedTestRepository,
  RequirementRepository,
  RunRepository,
  SecretRepository,
  newId,
  type Executor,
  type TestRun,
} from "@platform/db";
import type { RunEventPublisher } from "@platform/event-bus";
import { createRunRedactor, encryptSecret, secretFingerprint, validateTargetUrl } from "@platform/security";
import { createHmac } from "node:crypto";
import { actorId, runScope, type Principal } from "../auth/principal";
import type { ApiDeps } from "../deps";
import { HttpError, zodIssues } from "../errors";
import { CredentialProfileService } from "./credential-profile-service";
import { TestRunService, canonical, isUniqueViolation } from "./test-run-service";

/**
 * `POST /v1/test-runs/:runId/rerun` (V1.1 F5): a new run that reruns the source run's saved Playwright test —
 * no exploration, no model call. The source must be finished and have a generated test with at least one
 * compiled criterion. Its secrets were purged when it ended, so every one of them must be given again (typed,
 * or through saved credentials). The new run copies the source's confirmed requirement and generated test,
 * belongs to the caller, and counts towards the active-run cap.
 */
/** What a rerun reruns: the source's confirmed requirement and its generated test. */
export interface SavedTest {
  requirement: NormalizedRequirement;
  test: GeneratedTest;
}

export type CreatedRun = { run: TestRun; event: Awaited<ReturnType<EventRepository["append"]>> };

export class RerunService {
  private readonly runs: RunRepository;
  private readonly create: TestRunService;

  constructor(private readonly deps: ApiDeps) {
    this.runs = new RunRepository(deps.db);
    this.create = new TestRunService(deps);
  }

  /** The source's saved test; `409 NOTHING_TO_RERUN` when it has none (or it is not finished: `409 RUN_NOT_FINISHED`). */
  async savedTestOf(source: TestRun): Promise<SavedTest> {
    if (!isTerminalLifecycle(source.lifecycle)) {
      throw new HttpError(409, "RUN_NOT_FINISHED", "A run can be rerun once it has finished");
    }
    const [test, requirement] = await Promise.all([
      new GeneratedTestRepository(this.deps.db).findByRun(source.id),
      new RequirementRepository(this.deps.db).findLatest(source.id),
    ]);
    if (!test || test.compiledCriteria.length === 0 || !requirement?.confirmedAt) {
      throw new HttpError(409, "NOTHING_TO_RERUN", "This run has no generated Playwright test to rerun");
    }
    return { test, requirement };
  }

  /** `422 TARGET_NOT_ALLOWED` when the target is no longer allowed (checked again for every rerun). */
  async checkTarget(targetUrl: string, path: (string | number)[] = ["targetUrl"]): Promise<void> {
    const policy = await validateTargetUrl(targetUrl, {
      resolve: this.deps.resolve,
      privateAllowlist: this.deps.config.privateAllowlist,
    });
    if (!policy.allowed) {
      throw new HttpError(422, "TARGET_NOT_ALLOWED", `Target URL is not allowed: ${policy.detail}`, [{ path, message: policy.detail }]);
    }
  }

  /**
   * The rerun's stored request: the source's (the same requirement, test data, options and model — for display: no
   * model is called), redacted by key.
   */
  rerunRequest(source: TestRun, secrets: Record<string, string>, credentialProfile?: StoredTestRunRequest["credentialProfile"]): StoredTestRunRequest {
    const { credentialProfile: _sourceProfile, rerunOf: _sourceOf, ...inherited } = source.request;
    const redact = createRunRedactor();
    return {
      ...(redact(inherited) as typeof inherited),
      secretNames: Object.keys(secrets).sort(),
      rerunOf: source.id,
      ...(credentialProfile ? { credentialProfile } : {}),
    };
  }

  /**
   * Inside the caller's transaction: the rerun's run row, its secrets (encrypted, fingerprinted), copies of the
   * source's confirmed requirement and generated test, and its `run.created` event (to notify after commit).
   */
  async insert(
    tx: Executor,
    input: {
      runId: string;
      tenantId: string;
      source: TestRun;
      saved: SavedTest;
      stored: StoredTestRunRequest;
      secrets: Record<string, string>;
      ownerUserId: string | null;
      publisher: RunEventPublisher;
      idempotencyKey?: string | null;
      requestHash?: string | null;
      suiteRunId?: string | null;
    },
  ): Promise<CreatedRun> {
    const run = await new RunRepository(tx).create({
      id: input.runId,
      tenantId: input.tenantId,
      targetUrl: input.source.targetUrl,
      request: input.stored,
      idempotencyKey: input.idempotencyKey ?? null,
      requestHash: input.requestHash ?? null,
      ownerUserId: input.ownerUserId,
      suiteRunId: input.suiteRunId ?? null,
      // Every rerun of a test is compared with that test's earlier runs (V1.2 F2).
      comparisonKey: input.source.comparisonKey,
    });
    await new SecretRepository(tx).insertMany(
      run.id,
      Object.entries(input.secrets).map(([name, value]) => ({
        name,
        ...encryptSecret(value, { runId: run.id, name }, this.deps.config.secretsKey),
        fingerprint: secretFingerprint(value, this.deps.config.secretsKey).digest,
      })),
    );
    await new RequirementRepository(tx).copyConfirmed(run.id, input.saved.requirement);
    await new GeneratedTestRepository(tx).save(run.id, { ...input.saved.test, id: newId("gt") });
    const host = new URL(input.source.targetUrl).host;
    const event = await new EventRepository(tx).append(
      input.publisher.prepare({
        runId: run.id,
        stage: "QUEUED",
        type: "run.created",
        message: `Rerun of the saved test created for ${host}`,
        payload: { targetHost: host },
      }),
    );
    return { run, event };
  }

  /** Queues a created rerun; a queue failure errors it (QUEUE_UNAVAILABLE for a single rerun, the caller decides). */
  /** `suitePosition`: the run is a suite run's child, at this position in the suite (queued behind single runs). */
  async enqueue(run: TestRun, suitePosition?: number): Promise<boolean> {
    try {
      await this.deps.queue.enqueueRerun(run.id, suitePosition === undefined ? undefined : { suitePosition });
      return true;
    } catch {
      await this.create.failEnqueue(run);
      return false;
    }
  }

  async rerun(
    principal: Principal,
    sourceRunId: string,
    body: unknown,
    idempotencyKey: string | undefined,
  ): Promise<{ status: 202; body: CreateTestRunResponse; credentialProfileId?: string }> {
    const parsed = RerunRequestSchema.safeParse(body ?? {});
    if (!parsed.success) throw new HttpError(400, "VALIDATION_FAILED", "Request validation failed", zodIssues(parsed.error));
    const req = parsed.data;
    const { tenantId } = principal;

    const source = await this.runs.getRequired(runScope(principal), sourceRunId);
    const saved = await this.savedTestOf(source);
    // The saved test repeats every recorded action: a run that could delete or pay does so again.
    if (destructiveActionsAllowed(source.request) && req.confirmDestructiveActions !== true) {
      throw new HttpError(422, "CONFIRMATION_REQUIRED", "This run allowed destructive actions: confirm that the rerun repeats them", [
        { path: ["confirmDestructiveActions"], message: "The rerun repeats every action the test recorded, destructive ones included: confirm it" },
      ]);
    }

    // Every secret the saved test fills must be given again (the source's values are gone).
    let given = req.secrets;
    let credentialProfile: StoredTestRunRequest["credentialProfile"];
    if (req.credentialProfileId) {
      const profile = await new CredentialProfileService(this.deps).secretsFor(tenantId, req.credentialProfileId);
      given = { ...profile.secrets, ...req.secrets };
      credentialProfile = profile.ref;
    }
    const required = [...source.request.secretNames].sort();
    const missing = required.filter((n) => !Object.hasOwn(given, n));
    if (missing.length > 0) throw secretsRequired(missing);
    const secrets = Object.fromEntries(required.map((n) => [n, given[n]!]));

    // HMAC, not a plain hash: the body contains secrets.
    const requestHash = idempotencyKey
      ? createHmac("sha256", this.deps.config.secretsKey)
          .update(canonical({ rerunOf: source.id, secrets, credentialProfileId: req.credentialProfileId ?? null }))
          .digest("hex")
      : null;
    if (idempotencyKey) {
      if (idempotencyKey.length > 200) throw new HttpError(400, "VALIDATION_FAILED", "Idempotency-Key too long");
      const existing = await this.runs.findByIdempotencyKey(tenantId, idempotencyKey);
      const replayed = existing && (await this.create.replay(existing, requestHash!, principal));
      if (replayed) return replayed;
    }

    await this.checkTarget(source.targetUrl);

    const stored = this.rerunRequest(source, secrets, credentialProfile);
    const publisher = this.create.publisher(createRunRedactor());

    let created: CreatedRun;
    try {
      created = await this.deps.db.transaction(async (tx) => {
        const txRuns = new RunRepository(tx);
        await txRuns.lockTenant(tenantId);
        if ((await txRuns.countActive(tenantId)) >= this.deps.config.maxActiveRunsPerTenant) {
          throw new HttpError(429, "TOO_MANY_ACTIVE_RUNS", "Too many active runs; wait for one to finish");
        }
        return this.insert(tx, {
          runId: newId("run"),
          tenantId,
          source,
          saved,
          stored,
          secrets,
          ownerUserId: actorId(principal),
          publisher,
          idempotencyKey: idempotencyKey ?? null,
          requestHash,
        });
      });
    } catch (err) {
      if (idempotencyKey && isUniqueViolation(err)) {
        const existing = await this.runs.findByIdempotencyKey(tenantId, idempotencyKey);
        const replayed = existing && (await this.create.replay(existing, requestHash!, principal));
        if (replayed) return replayed;
        throw new HttpError(409, "IDEMPOTENCY_CONFLICT", "A request with this Idempotency-Key is being processed");
      }
      throw err;
    }

    await publisher.notify(created.event);
    if (!(await this.enqueue(created.run))) {
      throw new HttpError(503, "QUEUE_UNAVAILABLE", "The run could not be queued; please retry");
    }
    return {
      status: 202,
      body: this.create.response(created.run),
      ...(req.credentialProfileId ? { credentialProfileId: req.credentialProfileId } : {}),
    };
  }
}

/** `422 SECRETS_REQUIRED` naming each missing secret. */
export function secretsRequired(missing: readonly string[], why = "again: secret values are deleted when a run ends"): HttpError {
  return new HttpError(
    422,
    "SECRETS_REQUIRED",
    `Enter ${missing.join(", ")} ${why}`,
    missing.map((n) => ({ path: ["secrets", n], message: `Enter ${n} ${why}` })),
  );
}
