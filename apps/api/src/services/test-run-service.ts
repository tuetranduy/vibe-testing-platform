import {
  CreateTestRunRequestSchema,
  MAX_SECRETS,
  extractInlineInputs,
  MAX_TEST_DATA_ENTRIES,
  isTerminalLifecycle,
  type CreateTestRunResponse,
  type StoredTestRunRequest,
  type TestRunSummary,
} from "@platform/contracts";
import {
  EventRepository,
  IdempotencyConflictError,
  RunRepository,
  SecretRepository,
  StaleTransitionError,
  TestDataSetRepository,
  newId,
  UserRepository,
  toRunSummary,
  type TestRun,
} from "@platform/db";
import { createRunEventPublisher, type RunEventPublisher } from "@platform/event-bus";
import { catalogModel } from "@platform/llm/catalog";
import { createRunRedactor, encryptSecret, redactByKey, secretFingerprint, validateTargetUrl } from "@platform/security";
import { createHmac } from "node:crypto";
import { actorId, listScope, runScope, type Principal } from "../auth/principal";
import type { ApiDeps } from "../deps";
import { HttpError, zodIssues } from "../errors";
import { NO_VERDICT, observeStage } from "../metrics";
import { CredentialProfileService } from "./credential-profile-service";
import { resolveRunLlm } from "./llm-choice";
import { LlmSettingsService, modelNotAvailable } from "./llm-settings-service";

const ENQUEUE_FAILED = "Queue unavailable at creation";

/** Stable JSON (sorted keys) so equal bodies hash equally regardless of key order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Run summaries, with the model named as the catalog names it (the id when not in it) and the owner by name. */
export async function summariesOf(db: ApiDeps["db"], tenantId: string, runs: readonly TestRun[]): Promise<TestRunSummary[]> {
  const names = await new UserRepository(db).namesById(
    tenantId,
    runs.flatMap((r) => (r.ownerUserId ? [r.ownerUserId] : [])),
  );
  return runs.map((run) => toRunSummary(run, (model) => catalogModel(model)?.label ?? model, (id) => names.get(id) ?? null));
}

export async function summaryOf(db: ApiDeps["db"], run: TestRun): Promise<TestRunSummary> {
  return (await summariesOf(db, run.tenantId, [run]))[0]!;
}

export function isUniqueViolation(err: unknown): boolean {
  let e: unknown = err;
  for (let i = 0; i < 3 && e; i++) {
    if ((e as { code?: string }).code === "23505") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

export class TestRunService {
  private readonly runs: RunRepository;

  constructor(private readonly deps: ApiDeps) {
    this.runs = new RunRepository(deps.db);
  }

  /** Shared with RerunService. */
  publisher(redact: (v: unknown) => unknown = redactByKey): RunEventPublisher {
    return createRunEventPublisher({ events: new EventRepository(this.deps.db), redis: this.deps.redis, redact });
  }

  /** Shared with RerunService. */
  response(run: TestRun): CreateTestRunResponse {
    return { runId: run.id, lifecycle: "QUEUED", eventsUrl: `/v1/test-runs/${run.id}/events` };
  }

  async create(principal: Principal, body: unknown, idempotencyKey: string | undefined): Promise<{ status: 202; body: CreateTestRunResponse }> {
    const parsed = CreateTestRunRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpError(400, "VALIDATION_FAILED", "Request validation failed", zodIssues(parsed.error));
    }
    const req = parsed.data;
    const { tenantId } = principal;

    // HMAC, not a plain hash: the body contains secrets, which may be low-entropy.
    const requestHash = idempotencyKey
      ? createHmac("sha256", this.deps.config.secretsKey).update(canonical(req)).digest("hex")
      : null;
    if (idempotencyKey) {
      if (idempotencyKey.length > 200) throw new HttpError(400, "VALIDATION_FAILED", "Idempotency-Key too long");
      const existing = await this.runs.findByIdempotencyKey(tenantId, idempotencyKey);
      if (existing) {
        const replayed = await this.replay(existing, requestHash!, principal);
        if (replayed) return replayed;
      }
    }

    const policy = await validateTargetUrl(req.targetUrl, {
      resolve: this.deps.resolve,
      privateAllowlist: this.deps.config.privateAllowlist,
    });
    if (!policy.allowed) {
      throw new HttpError(422, "TARGET_NOT_ALLOWED", `Target URL is not allowed: ${policy.detail}`, [
        { path: ["targetUrl"], message: policy.detail },
      ]);
    }

    // The run's model: the request's override, else the defaults saved in Settings, else the environment's.
    // Checked here, so a run whose provider has no key (or whose model or level is not offered) is refused now
    // instead of failing in the worker. Changing Settings later never changes this run's choice.
    const { saved, availability } = await new LlmSettingsService(this.deps).state(tenantId);
    const resolved = resolveRunLlm({ override: req.llm, saved, env: this.deps.config.llm.envChoice, availability });
    if (!resolved.ok) throw modelNotAvailable(resolved.issue);

    // A saved test data set (V1.1 F3): its values under the request's own, copied now.
    let testData = req.testData;
    let testDataSet: StoredTestRunRequest["testDataSet"];
    if (req.testDataSetId) {
      const set = await new TestDataSetRepository(this.deps.db).find(tenantId, req.testDataSetId);
      if (!set) {
        throw new HttpError(422, "TEST_DATA_SET_NOT_FOUND", "The saved test data set does not exist (it may have been deleted)", [
          { path: ["testDataSetId"], message: "This test data set no longer exists" },
        ]);
      }
      testData = { ...set.values, ...req.testData };
      testDataSet = { id: set.id, name: set.name };
      if (Object.keys(testData).length > MAX_TEST_DATA_ENTRIES) {
        throw new HttpError(400, "VALIDATION_FAILED", "Request validation failed", [
          { path: ["testData"], message: `At most ${MAX_TEST_DATA_ENTRIES} test data entries, the saved set's included` },
        ]);
      }
    }

    // Saved credentials (V1.1 F4, D7 amended): the profile's values become this run's own secrets, below the
    // request's; they are encrypted, fingerprinted, redacted and purged exactly like typed ones.
    let secrets = req.secrets;
    let credentialProfile: StoredTestRunRequest["credentialProfile"];
    if (req.credentialProfileId) {
      const saved = await new CredentialProfileService(this.deps).secretsFor(tenantId, req.credentialProfileId);
      secrets = { ...saved.secrets, ...req.secrets };
      credentialProfile = saved.ref;
      if (Object.keys(secrets).length > MAX_SECRETS) {
        throw new HttpError(400, "VALIDATION_FAILED", "Request validation failed", [
          { path: ["secrets"], message: `At most ${MAX_SECRETS} secrets, the saved credentials' included` },
        ]);
      }
    }

    // Credentials written in the requirement itself (V1.3.1) are used, not ignored: emails and usernames become
    // test data, passwords become secrets (encrypted like typed ones) and leave the text. What the user entered
    // explicitly wins; nothing is added past the limits.
    const inline = extractInlineInputs(req.requirement, { testData, secrets, maxSecrets: MAX_SECRETS, maxTestData: MAX_TEST_DATA_ENTRIES });
    testData = { ...inline.testData, ...testData };
    secrets = { ...inline.secrets, ...secrets };

    // `llm` is stored as the resolved choice, not the override the request sent.
    const { secrets: _typed, llm: _override, testDataSetId: _set, credentialProfileId: _profile, ...requested } = req;
    const rest = { ...requested, requirement: inline.text, testData };
    // Redacted by key before anything is persisted; secret values are kept as typed (2026-10-07).
    const redact = createRunRedactor();
    const stored: StoredTestRunRequest = {
      ...(redact(rest) as typeof rest),
      secretNames: Object.keys(secrets).sort(),
      llm: resolved.choice,
      ...(testDataSet ? { testDataSet } : {}),
      ...(credentialProfile ? { credentialProfile } : {}),
      ...(inline.found.length > 0 ? { inlineInputs: inline.found } : {}),
    };
    const publisher = this.publisher(redact);
    const runId = newId("run");

    let created: { run: TestRun; event: Awaited<ReturnType<EventRepository["append"]>> };
    try {
      created = await this.deps.db.transaction(async (tx) => {
        const txRuns = new RunRepository(tx);
        // Admission check under a tenant row lock, so concurrent creates can't exceed the cap.
        await txRuns.lockTenant(tenantId);
        if ((await txRuns.countActive(tenantId)) >= this.deps.config.maxActiveRunsPerTenant) {
          throw new HttpError(429, "TOO_MANY_ACTIVE_RUNS", "Too many active runs; wait for one to finish");
        }
        const run = await txRuns.create({
          id: runId,
          tenantId,
          targetUrl: req.targetUrl,
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
            // Lets the API find this value in text edited later without decrypting it (D7).
            fingerprint: secretFingerprint(value, this.deps.config.secretsKey).digest,
          })),
        );
        const event = await new EventRepository(tx).append(
          publisher.prepare({
            runId: run.id,
            stage: "QUEUED",
            type: "run.created",
            message: `Test run created for ${new URL(req.targetUrl).host}`,
            payload: { targetHost: new URL(req.targetUrl).host },
          }),
        );
        return { run, event };
      });
    } catch (err) {
      if (idempotencyKey && isUniqueViolation(err)) {
        const existing = await this.runs.findByIdempotencyKey(tenantId, idempotencyKey);
        const replayed = existing && (await this.replay(existing, requestHash!, principal));
        if (replayed) return replayed;
        throw new HttpError(409, "IDEMPOTENCY_CONFLICT", "A request with this Idempotency-Key is being processed");
      }
      throw err;
    }

    await publisher.notify(created.event);
    try {
      await this.deps.queue.enqueueAnalyze(created.run.id);
    } catch {
      await this.failEnqueue(created.run);
      throw new HttpError(503, "QUEUE_UNAVAILABLE", "The run could not be queued; please retry");
    }
    return { status: 202, body: this.response(created.run) };
  }

  /**
   * Same key + same body → the original response. A run that failed to enqueue (the client got 503
   * and was told to retry) releases its key so the retry creates a fresh run; returns null then.
   */
  /** Shared with RerunService. */
  async replay(existing: TestRun, requestHash: string, principal: Principal): Promise<{ status: 202; body: CreateTestRunResponse } | null> {
    // Another user's key is never replayed to this caller: same outcome as a different body.
    if (existing.requestHash !== requestHash || existing.ownerUserId !== actorId(principal)) throw new IdempotencyConflictError(existing.id);
    if (existing.lifecycle === "ERRORED" && existing.errorMessage === ENQUEUE_FAILED) {
      await this.runs.releaseIdempotencyKey(existing.id);
      return null;
    }
    return { status: 202, body: this.response(existing) };
  }

  /** Shared with RerunService. */
  async failEnqueue(run: TestRun): Promise<void> {
    try {
      const errored = await this.runs.transition(run.id, "QUEUED", "ERRORED", {
        errorCategory: "INTERNAL",
        errorMessage: ENQUEUE_FAILED,
      });
      observeStage(this.deps.metrics, "QUEUED", run.lifecycleChangedAt, errored.lifecycleChangedAt);
      this.deps.metrics?.testRuns.inc({ lifecycle: "ERRORED", verdict: NO_VERDICT });
      await new SecretRepository(this.deps.db).purge(run.id);
      await this.publisher().publish({
        runId: run.id,
        stage: "ERRORED",
        type: "run.errored",
        message: "Run could not be queued",
        payload: { category: "INTERNAL", message: ENQUEUE_FAILED },
      });
    } catch {
      // best effort; a run left QUEUED here is ended by the reaper ("never picked up")
    }
  }

  async get(principal: Principal, runId: string): Promise<TestRunSummary> {
    return summaryOf(this.deps.db, await this.runs.getRequired(runScope(principal), runId));
  }

  async list(
    principal: Principal,
    limit: number,
    cursor: string | null,
    owner?: "me" | "all",
  ): Promise<{ items: TestRunSummary[]; nextCursor: string | null }> {
    const page = await this.runs.list(listScope(principal, owner), { limit, cursor });
    return { items: await summariesOf(this.deps.db, principal.tenantId, page.items), nextCursor: page.nextCursor };
  }

  /**
   * QUEUED / AWAITING_SELECTION / AWAITING_CONFIRMATION: cancelled immediately (no worker holds them).
   * Active: cancel requested + Redis signal; the worker stops at the next boundary.
   */
  async cancel(principal: Principal, runId: string): Promise<TestRunSummary> {
    const scope = runScope(principal);
    let run = await this.runs.getRequired(scope, runId);
    if (isTerminalLifecycle(run.lifecycle)) {
      throw new HttpError(409, "RUN_TERMINAL", `Run is already ${run.lifecycle}`);
    }

    if (run.lifecycle === "QUEUED" || run.lifecycle === "AWAITING_SELECTION" || run.lifecycle === "AWAITING_CONFIRMATION") {
      try {
        const cancelled = await this.runs.transition(run.id, run.lifecycle, "CANCELLED", {
          cancelReason: "USER_REQUESTED",
          cancelRequestedAt: new Date(),
        });
        observeStage(this.deps.metrics, run.lifecycle, run.lifecycleChangedAt, cancelled.lifecycleChangedAt);
        this.deps.metrics?.testRuns.inc({ lifecycle: "CANCELLED", verdict: NO_VERDICT });
        await new SecretRepository(this.deps.db).purge(run.id);
        await this.publisher().publish({
          runId: run.id,
          stage: "CANCELLED",
          type: "run.cancelled",
          message: "Run cancelled by user",
          payload: { reason: "USER_REQUESTED" },
        });
        return summaryOf(this.deps.db, cancelled);
      } catch (err) {
        if (!(err instanceof StaleTransitionError)) throw err;
        run = await this.runs.getRequired(scope, runId); // a worker picked it up; fall through
        if (isTerminalLifecycle(run.lifecycle)) throw new HttpError(409, "RUN_TERMINAL", `Run is already ${run.lifecycle}`);
      }
    }

    const marked = await this.runs.requestCancel(run.id, "USER_REQUESTED");
    if (!marked) throw new HttpError(409, "RUN_TERMINAL", "Run already finished");
    await this.deps.cancelSignal.send(run.id);
    return summaryOf(this.deps.db, marked);
  }
}
