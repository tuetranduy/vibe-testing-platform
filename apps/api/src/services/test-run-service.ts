import {
  CreateTestRunRequestSchema,
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
  newId,
  toRunSummary,
  type TestRun,
} from "@platform/db";
import { createRunEventPublisher, type RunEventPublisher } from "@platform/event-bus";
import { catalogModel } from "@platform/llm/catalog";
import { createRunRedactor, encryptSecret, redactByKey, validateTargetUrl } from "@platform/security";
import { createHmac } from "node:crypto";
import type { ApiDeps } from "../deps";
import { HttpError, zodIssues } from "../errors";
import { NO_VERDICT, observeStage } from "../metrics";
import { resolveRunLlm } from "./llm-choice";
import { LlmSettingsService, modelNotAvailable } from "./llm-settings-service";

const ENQUEUE_FAILED = "Queue unavailable at creation";

/** Stable JSON (sorted keys) so equal bodies hash equally regardless of key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The run summary, with the model named as the catalog names it (the id when not in the catalog). */
const summaryOf = (run: TestRun): TestRunSummary => toRunSummary(run, (model) => catalogModel(model)?.label ?? model);

function isUniqueViolation(err: unknown): boolean {
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

  private publisher(redact: (v: unknown) => unknown = redactByKey): RunEventPublisher {
    return createRunEventPublisher({ events: new EventRepository(this.deps.db), redis: this.deps.redis, redact });
  }

  private response(run: TestRun): CreateTestRunResponse {
    return { runId: run.id, lifecycle: "QUEUED", eventsUrl: `/v1/test-runs/${run.id}/events` };
  }

  async create(body: unknown, idempotencyKey: string | undefined): Promise<{ status: 202; body: CreateTestRunResponse }> {
    const parsed = CreateTestRunRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpError(400, "VALIDATION_FAILED", "Request validation failed", zodIssues(parsed.error));
    }
    const req = parsed.data;
    const { tenantId } = { tenantId: this.deps.config.defaultTenantId };

    // HMAC, not a plain hash: the body contains secrets, which may be low-entropy.
    const requestHash = idempotencyKey
      ? createHmac("sha256", this.deps.config.secretsKey).update(canonical(req)).digest("hex")
      : null;
    if (idempotencyKey) {
      if (idempotencyKey.length > 200) throw new HttpError(400, "VALIDATION_FAILED", "Idempotency-Key too long");
      const existing = await this.runs.findByIdempotencyKey(tenantId, idempotencyKey);
      if (existing) {
        const replayed = await this.replay(existing, requestHash!);
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

    // `llm` is stored as the resolved choice, not the override the request sent.
    const { secrets, llm: _override, ...rest } = req;
    const redact = createRunRedactor(Object.values(secrets));
    // Secret values can also appear in the requirement text or test data: redact them by key and
    // value before anything is persisted (D7). The worker only ever sees this redacted copy.
    const stored: StoredTestRunRequest = {
      ...(redact(rest) as typeof rest),
      secretNames: Object.keys(secrets).sort(),
      llm: resolved.choice,
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
        });
        await new SecretRepository(tx).insertMany(
          run.id,
          Object.entries(secrets).map(([name, value]) => ({
            name,
            ...encryptSecret(value, { runId: run.id, name }, this.deps.config.secretsKey),
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
        const replayed = existing && (await this.replay(existing, requestHash!));
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
  private async replay(existing: TestRun, requestHash: string): Promise<{ status: 202; body: CreateTestRunResponse } | null> {
    if (existing.requestHash !== requestHash) throw new IdempotencyConflictError(existing.id);
    if (existing.lifecycle === "ERRORED" && existing.errorMessage === ENQUEUE_FAILED) {
      await this.runs.releaseIdempotencyKey(existing.id);
      return null;
    }
    return { status: 202, body: this.response(existing) };
  }

  private async failEnqueue(run: TestRun): Promise<void> {
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
      // best effort; the reaper does not touch QUEUED runs, so log-level visibility is enough here
    }
  }

  async get(runId: string): Promise<TestRunSummary> {
    return summaryOf(await this.runs.getRequired(this.deps.config.defaultTenantId, runId));
  }

  async list(limit: number, cursor: string | null): Promise<{ items: TestRunSummary[]; nextCursor: string | null }> {
    const page = await this.runs.list(this.deps.config.defaultTenantId, { limit, cursor });
    return { items: page.items.map(summaryOf), nextCursor: page.nextCursor };
  }

  /**
   * QUEUED / AWAITING_CONFIRMATION: cancelled immediately (no worker holds them).
   * Active: cancel requested + Redis signal; the worker stops at the next boundary.
   */
  async cancel(runId: string): Promise<TestRunSummary> {
    const tenantId = this.deps.config.defaultTenantId;
    let run = await this.runs.getRequired(tenantId, runId);
    if (isTerminalLifecycle(run.lifecycle)) {
      throw new HttpError(409, "RUN_TERMINAL", `Run is already ${run.lifecycle}`);
    }

    if (run.lifecycle === "QUEUED" || run.lifecycle === "AWAITING_CONFIRMATION") {
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
        return summaryOf(cancelled);
      } catch (err) {
        if (!(err instanceof StaleTransitionError)) throw err;
        run = await this.runs.getRequired(tenantId, runId); // a worker picked it up; fall through
        if (isTerminalLifecycle(run.lifecycle)) throw new HttpError(409, "RUN_TERMINAL", `Run is already ${run.lifecycle}`);
      }
    }

    const marked = await this.runs.requestCancel(run.id, "USER_REQUESTED");
    if (!marked) throw new HttpError(409, "RUN_TERMINAL", "Run already finished");
    await this.deps.cancelSignal.send(run.id);
    return summaryOf(marked);
  }
}
