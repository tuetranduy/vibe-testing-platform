import { NormalizedRequirementSchema, type NormalizedRequirement } from "@platform/contracts";
import { EventRepository, RequirementRepository, RunRepository, SecretRepository } from "@platform/db";
import { createRunEventPublisher, type RunEventPublisher } from "@platform/event-bus";
import { redactByKey } from "@platform/security";
import type { ApiDeps } from "../deps";
import { HttpError, zodIssues } from "../errors";
import { applyCriteriaEdit } from "./criteria-edit";
import { NO_VERDICT, observeStage } from "../metrics";

const ENQUEUE_FAILED = "Queue unavailable after confirmation";

export interface ConfirmResult {
  revision: number;
  warnings: string[];
}

/**
 * Lets a user read, edit, and confirm the criteria compiled for a run (Task 10's analyze-run job).
 * Confirmation freezes the requirement and releases the run into execution (D5).
 */
export class CriteriaService {
  private readonly runs: RunRepository;
  private readonly requirements: RequirementRepository;

  constructor(private readonly deps: ApiDeps) {
    this.runs = new RunRepository(deps.db);
    this.requirements = new RequirementRepository(deps.db);
  }

  /**
   * Secret plaintext is never available at the API layer (D7: decrypted only in the worker), so
   * only key-based redaction is possible here.
   */
  private publisher(): RunEventPublisher {
    return createRunEventPublisher({ events: new EventRepository(this.deps.db), redis: this.deps.redis, redact: redactByKey });
  }

  async get(runId: string): Promise<NormalizedRequirement> {
    const tenantId = this.deps.config.defaultTenantId;
    await this.runs.getRequired(tenantId, runId);
    const requirement = await this.requirements.findLatest(runId);
    if (!requirement) {
      throw new HttpError(409, "CRITERIA_NOT_READY", "Criteria have not been compiled for this run yet");
    }
    return requirement;
  }

  /**
   * Saves a new revision from a full NormalizedRequirement-shaped body. `runId`, `revision` and
   * `confirmedAt` are taken from the URL / server, never the body. `originalText` must be unchanged.
   * Criteria may be removed and a criterion's check values edited; the server writes the statement
   * of every edited criterion (applyCriteriaEdit), anything else is 400. Outside
   * AWAITING_CONFIRMATION (or before any revision exists) it is 409.
   */
  async update(runId: string, body: unknown): Promise<NormalizedRequirement> {
    const tenantId = this.deps.config.defaultTenantId;
    const run = await this.runs.getRequired(tenantId, runId);

    const parsed = NormalizedRequirementSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpError(400, "VALIDATION_FAILED", "Request validation failed", zodIssues(parsed.error));
    }
    const req = parsed.data;

    const latest = await this.requirements.findLatest(runId);
    if (latest && latest.originalText !== req.originalText) {
      throw new HttpError(400, "VALIDATION_FAILED", "originalText cannot change between revisions", [
        { path: ["originalText"], message: "originalText cannot change between revisions" },
      ]);
    }

    // Review edits (spec 2026-09-26-criteria-check-edit) exist only while the run waits for
    // confirmation (D5): before that the worker is still writing revision 1, after it they're frozen.
    // createRevision's row-locked lifecycle/frozen guards still catch a run that moves on meanwhile.
    if (run.lifecycle !== "AWAITING_CONFIRMATION" || !latest) {
      throw new HttpError(409, "CONFLICT", `Run is ${run.lifecycle}; criteria can only change while it awaits confirmation`);
    }
    const edit = applyCriteriaEdit(latest, req);
    if (!edit.ok) {
      const message =
        edit.code === "STATEMENT_ONLY_EDIT"
          ? "A criterion's wording can only change together with its check"
          : "Only a criterion's check values can change during review";
      throw new HttpError(400, edit.code, message, edit.issues);
    }

    const updated = await this.requirements.createRevision(runId, { originalText: req.originalText, criteria: edit.criteria, facts: edit.facts });

    await this.publisher().publish({
      runId,
      stage: run.lifecycle,
      type: "criteria.updated",
      message: `Criteria revision ${updated.revision} saved`,
      payload: { revision: updated.revision },
    });

    return updated;
  }

  /**
   * Confirms the latest revision (race-safe via RequirementRepository.confirm's row lock), then
   * mirrors the worker's auto-confirm sequence: publish criteria.confirmed → transition to PLANNING
   * with heartbeatAt = now → enqueue execute-run. A queue failure after the transition errors the run.
   */
  async confirm(runId: string): Promise<ConfirmResult> {
    const tenantId = this.deps.config.defaultTenantId;
    const run = await this.runs.getRequired(tenantId, runId);
    if (run.lifecycle !== "AWAITING_CONFIRMATION") {
      throw new HttpError(409, "CONFLICT", `Run is ${run.lifecycle}; criteria cannot be confirmed`);
    }

    const latest = await this.requirements.getLatest(runId);
    const confirmed = await this.requirements.confirm(runId, latest.revision);

    const warnings = confirmed.criteria
      .filter((c) => c.ambiguity !== null || c.expectedOutcome.kind === "semantic")
      .map((c) => `Criterion ${c.id} will be reported as Inconclusive`);

    await this.publisher().publish({
      runId,
      stage: run.lifecycle, // AWAITING_CONFIRMATION, captured before the transition below
      type: "criteria.confirmed",
      message: `Criteria revision ${confirmed.revision} confirmed`,
      payload: { revision: confirmed.revision },
    });

    const planned = await this.runs.transition(runId, "AWAITING_CONFIRMATION", "PLANNING", { heartbeatAt: new Date() });
    observeStage(this.deps.metrics, "AWAITING_CONFIRMATION", run.lifecycleChangedAt, planned.lifecycleChangedAt);

    try {
      await this.deps.queue.enqueueExecute(runId);
    } catch {
      await this.failEnqueue(runId, planned.lifecycleChangedAt);
      throw new HttpError(503, "QUEUE_UNAVAILABLE", "The run could not be queued; please retry");
    }

    return { revision: confirmed.revision, warnings };
  }

  private async failEnqueue(runId: string, plannedAt: Date): Promise<void> {
    try {
      const errored = await this.runs.transition(runId, "PLANNING", "ERRORED", {
        errorCategory: "INTERNAL",
        errorMessage: ENQUEUE_FAILED,
      });
      observeStage(this.deps.metrics, "PLANNING", plannedAt, errored.lifecycleChangedAt);
      this.deps.metrics?.testRuns.inc({ lifecycle: "ERRORED", verdict: NO_VERDICT });
      await new SecretRepository(this.deps.db).purge(runId);
      await this.publisher().publish({
        runId,
        stage: "ERRORED",
        type: "run.errored",
        message: "Run could not be queued",
        payload: { category: "INTERNAL", message: ENQUEUE_FAILED },
      });
    } catch {
      // best effort; mirrors TestRunService.failEnqueue
    }
  }
}
