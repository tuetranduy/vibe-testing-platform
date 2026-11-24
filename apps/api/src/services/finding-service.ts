import {
  FindingIdSchema,
  findingStatus,
  reproductionRequirement,
  type CreateTestRunResponse,
  type ExploratoryFinding,
  type FindingsResponse,
  type StoredFinding,
} from "@platform/contracts";
import { FindingRepository, RunRepository, type RunScope } from "@platform/db";
import type { Principal } from "../auth/principal";
import type { ApiDeps } from "../deps";
import { HttpError } from "../errors";
import { TestRunService } from "./test-run-service";

const notFound = () => new HttpError(404, "FINDING_NOT_FOUND", "This run has no such finding");

/**
 * Phase C: a run's exploratory findings. They are hypotheses until a person dismisses one or starts its
 * reproduction: a new run of the platform's own pipeline, whose verdict alone decides the finding's status
 * (`findingStatus`). Nothing here changes a run's verdict or criterion results.
 */
export class FindingService {
  private readonly runs: RunRepository;
  private readonly findings: FindingRepository;

  constructor(private readonly deps: ApiDeps) {
    this.runs = new RunRepository(deps.db);
    this.findings = new FindingRepository(deps.db);
  }

  private async statusOf(scope: RunScope, finding: StoredFinding) {
    const reproduction = finding.reproductionRunId
      ? await this.runs.getRequired(scope, finding.reproductionRunId).catch(() => null)
      : null;
    return findingStatus(finding, reproduction);
  }

  private async withStatus(scope: RunScope, finding: StoredFinding, runId?: string): Promise<ExploratoryFinding> {
    const own = await this.statusOf(scope, finding);
    if (!runId) return { ...finding, ...own };
    // The same problem in the tenant's other runs: how often, and whether a reproduction or a reviewer settled it there.
    const others = await this.findings.recurrences(scope.tenantId, finding, runId);
    const statuses = await Promise.all(others.map(({ finding: other }) => this.statusOf(scope, other)));
    return {
      ...finding, ...own,
      recurrence: {
        otherRuns: new Set(others.map((o) => o.runId)).size,
        reproducedElsewhere: statuses.some((s) => s.status === "REPRODUCED"),
        dismissedElsewhere: statuses.some((s) => s.status === "DISMISSED"),
      },
    };
  }

  async list(scope: RunScope, runId: string): Promise<FindingsResponse> {
    await this.runs.getRequired(scope, runId);
    // The reproduction run is read in the tenant only (a teammate's reproduction counts for an admin's view too).
    const tenant = { tenantId: scope.tenantId };
    return { findings: await Promise.all((await this.findings.list(runId)).map((f) => this.withStatus(tenant, f, runId))) };
  }

  private async load(scope: RunScope, runId: string, findingId: string): Promise<StoredFinding> {
    await this.runs.getRequired(scope, runId);
    if (!FindingIdSchema.safeParse(findingId).success) throw notFound();
    const finding = await this.findings.get(runId, findingId);
    if (!finding) throw notFound();
    return finding;
  }

  /** A reviewer's dismissal. A finding already reproduced stays reproduced: the evidence outranks the review. */
  async dismiss(scope: RunScope, runId: string, findingId: string, now = new Date()): Promise<ExploratoryFinding> {
    const finding = await this.load(scope, runId, findingId);
    const tenant = { tenantId: scope.tenantId };
    const current = await this.withStatus(tenant, finding);
    if (current.status === "REPRODUCED") {
      throw new HttpError(409, "FINDING_REPRODUCED", "This finding was reproduced by an independent run; it can no longer be dismissed");
    }
    if (current.statusReason === "reproduction_running") {
      throw new HttpError(409, "FINDING_REPRODUCING", "This finding's reproduction is still running");
    }
    if (finding.dismissedAt) return current;
    const dismissed = { ...finding, dismissedAt: now.toISOString() };
    await this.findings.update(runId, dismissed);
    return this.withStatus(tenant, dismissed);
  }

  /**
   * Starts the independent reproduction: a new run at the finding's page with a requirement built from its steps
   * and expected behavior, criteria confirmed by a person (never automatically), no discovery, no destructive
   * actions and the source run's model. One reproduction per finding (the idempotency key names it).
   */
  async reproduce(principal: Principal, scope: RunScope, runId: string, findingId: string): Promise<{ finding: ExploratoryFinding; run: CreateTestRunResponse }> {
    const finding = await this.load(scope, runId, findingId);
    if (finding.dismissedAt) throw new HttpError(409, "FINDING_DISMISSED", "This finding was dismissed");
    const source = await this.runs.getRequired(scope, runId);
    const llm = source.request.llm;
    const { body } = await new TestRunService(this.deps).create(principal, {
      targetUrl: finding.url,
      requirement: reproductionRequirement(finding),
      environment: source.request.environment,
      options: { autoConfirmCriteria: false, allowDestructiveActions: false, maxRunSeconds: source.request.options.maxRunSeconds },
      ...(llm && { llm: { model: llm.model, reasoning: llm.reasoning } }),
    }, `finding:${runId}:${findingId}`, { reproducesFinding: { runId, findingId } });
    const linked = { ...finding, reproductionRunId: body.runId };
    if (finding.reproductionRunId !== body.runId) await this.findings.update(runId, linked);
    return { finding: await this.withStatus({ tenantId: scope.tenantId }, linked), run: body };
  }
}
