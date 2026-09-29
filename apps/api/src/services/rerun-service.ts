import { RerunRequestSchema, isTerminalLifecycle, type CreateTestRunResponse, type StoredTestRunRequest } from "@platform/contracts";
import {
  EventRepository,
  GeneratedTestRepository,
  RequirementRepository,
  RunRepository,
  SecretRepository,
  newId,
  type TestRun,
} from "@platform/db";
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
export class RerunService {
  private readonly runs: RunRepository;
  private readonly create: TestRunService;

  constructor(private readonly deps: ApiDeps) {
    this.runs = new RunRepository(deps.db);
    this.create = new TestRunService(deps);
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

    // Every secret the saved test fills must be given again (the source's values are gone).
    let given = req.secrets;
    let credentialProfile: StoredTestRunRequest["credentialProfile"];
    if (req.credentialProfileId) {
      const saved = await new CredentialProfileService(this.deps).secretsFor(tenantId, req.credentialProfileId);
      given = { ...saved.secrets, ...req.secrets };
      credentialProfile = saved.ref;
    }
    const required = [...source.request.secretNames].sort();
    const missing = required.filter((n) => !Object.hasOwn(given, n));
    if (missing.length > 0) {
      throw new HttpError(
        422,
        "SECRETS_REQUIRED",
        `Enter ${missing.join(", ")} again: secret values are deleted when a run ends`,
        missing.map((n) => ({ path: ["secrets", n], message: `Enter ${n} again: secret values are deleted when a run ends` })),
      );
    }
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

    const policy = await validateTargetUrl(source.targetUrl, {
      resolve: this.deps.resolve,
      privateAllowlist: this.deps.config.privateAllowlist,
    });
    if (!policy.allowed) {
      throw new HttpError(422, "TARGET_NOT_ALLOWED", `Target URL is not allowed: ${policy.detail}`, [
        { path: ["targetUrl"], message: policy.detail },
      ]);
    }

    // The source's request, as the rerun's own: the same requirement, test data, options and model (for
    // display: no model is called). Redacted by the new values too, in case one appears in its text.
    const { credentialProfile: _sourceProfile, rerunOf: _sourceOf, ...inherited } = source.request;
    const redact = createRunRedactor(Object.values(secrets));
    const stored: StoredTestRunRequest = {
      ...(redact(inherited) as typeof inherited),
      secretNames: required,
      rerunOf: source.id,
      ...(credentialProfile ? { credentialProfile } : {}),
    };
    const publisher = this.create.publisher(redact);
    const runId = newId("run");
    const host = new URL(source.targetUrl).host;

    let created: { run: TestRun; event: Awaited<ReturnType<EventRepository["append"]>> };
    try {
      created = await this.deps.db.transaction(async (tx) => {
        const txRuns = new RunRepository(tx);
        await txRuns.lockTenant(tenantId);
        if ((await txRuns.countActive(tenantId)) >= this.deps.config.maxActiveRunsPerTenant) {
          throw new HttpError(429, "TOO_MANY_ACTIVE_RUNS", "Too many active runs; wait for one to finish");
        }
        const run = await txRuns.create({
          id: runId,
          tenantId,
          targetUrl: source.targetUrl,
          request: stored,
          idempotencyKey: idempotencyKey ?? null,
          requestHash,
          ownerUserId: actorId(principal),
        });
        await new SecretRepository(tx).insertMany(
          run.id,
          Object.entries(secrets).map(([name, value]) => ({
            name,
            ...encryptSecret(value, { runId: run.id, name }, this.deps.config.secretsKey),
            fingerprint: secretFingerprint(value, this.deps.config.secretsKey).digest,
          })),
        );
        await new RequirementRepository(tx).copyConfirmed(run.id, requirement);
        await new GeneratedTestRepository(tx).save(run.id, { ...test, id: newId("gt") });
        const event = await new EventRepository(tx).append(
          publisher.prepare({
            runId: run.id,
            stage: "QUEUED",
            type: "run.created",
            message: `Rerun of the saved test created for ${host}`,
            payload: { targetHost: host },
          }),
        );
        return { run, event };
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
    try {
      await this.deps.queue.enqueueRerun(created.run.id);
    } catch {
      await this.create.failEnqueue(created.run);
      throw new HttpError(503, "QUEUE_UNAVAILABLE", "The run could not be queued; please retry");
    }
    return {
      status: 202,
      body: this.create.response(created.run),
      ...(req.credentialProfileId ? { credentialProfileId: req.credentialProfileId } : {}),
    };
  }
}
