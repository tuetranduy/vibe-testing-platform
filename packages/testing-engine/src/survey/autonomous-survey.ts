import { setTimeout as delay } from "node:timers/promises";
import {
  DiscoveryFixtureUrlSchema,
  SuggestionSchema,
  type DiscoveryCandidate,
  type DiscoveryOutcomeReason,
  type DiscoveryOutcomeStatus,
  type DiscoveryResult,
  type DiscoverySummary,
  type Suggestion,
  type SuggestionSetDraft,
} from "@platform/contracts";
import { assertActionAllowed } from "@platform/security";
import { DiscoveryPortError, type AutonomousDiscoveryPort } from "../discovery/port";
import type { EngineStages, StageContext } from "../orchestrator/stages";

const MAX_DISCOVERY_MS = 120_000;
// Leave time for the existing orchestrator to save and publish the suggestions after a timeout.
const SURVEY_COMPLETION_MS = 5_000;
// The broker's whole job budget ends this long before the stage's own deadline, so its typed timeout or partial
// reply arrives before the stage stops waiting (the launcher stops its container within the job budget).
export const DISCOVERY_RESULT_GRACE_S = 5;
const MIN_JOB_SECONDS = 10;
const ROLLOUT_CHECK_MS = 2_000;
const MAX_SUGGESTIONS = 8;
const PRESERVED_SURVEY_COUNT = 2;

export interface AutonomousSurveyDeps {
  /** Both absent: this worker has no discovery transport; opted-in runs record BLOCKED / not_configured. */
  fixtureUrl?: string;
  port?: AutonomousDiscoveryPort;
  /** The tenant's rollout flag. A disable closes admission and stops in-flight discovery. */
  allowsTenant?: (tenantId: string) => boolean | Promise<boolean>;
  /** Claims one attempt of the tenant's quota. False: BUSY / tenant_quota, without starting a job. */
  reserve?: (tenantId: string) => boolean | Promise<boolean>;
  /** Returns one attempt to the tenant's quota when the run was never admitted to a broker slot. */
  refund?: (tenantId: string) => void | Promise<void>;
  /**
   * Fair admission to the broker's bounded job slots, shared by every worker (round robin across tenants). The
   * wait counts against the run's discovery budget. Absent: the broker's own single slot answers busy at once.
   */
  admit?: (request: DiscoveryAdmissionRequest) => Promise<DiscoveryAdmission>;
  /** Every opted-in run's outcome; `elapsedSeconds` is null when no broker job was attempted. */
  observe?: (summary: DiscoverySummary, elapsedSeconds: number | null) => void;
  logger?: { warn(obj: object, message: string): void };
}

export interface DiscoveryAdmissionRequest {
  tenantId: string;
  runId: string;
  maxWaitMs: number;
  /** The lease ends by itself after this long: the job's whole budget plus a grace period. */
  leaseMs: number;
  signal: AbortSignal;
}
export type DiscoveryAdmission = { granted: true; waitedMs: number; release(): Promise<void> } | { granted: false; waitedMs: number };
// After the broker's job budget: its container cleanup (≤ 18 s) and a margin, before a lost lease frees itself.
const LEASE_GRACE_MS = 30_000;

const MESSAGES: Record<DiscoveryOutcomeStatus, string> = {
  COMPLETED: "Browser Use discovery finished",
  PARTIAL: "Browser Use returned no reviewable ideas. Showing standard survey suggestions.",
  TIMED_OUT: "Browser Use reached its time limit. Showing standard survey suggestions.",
  BUSY: "Browser Use was busy with other runs. Showing standard survey suggestions.",
  BLOCKED: "Browser Use is not available for this run. Showing standard survey suggestions.",
  FAILED: "Browser Use was unavailable. Showing standard survey suggestions.",
  CANCELLED: "Browser Use stopped before it finished. Showing standard survey suggestions.",
};

/** The broker's status and reason, as the platform classifies them: a time limit is TIMED_OUT, not a failure. */
export function classifyDiscoveryResult(result: DiscoveryResult): { status: DiscoveryOutcomeStatus; reason: DiscoveryOutcomeReason } {
  const reason = result.reason ?? (result.status === "COMPLETED" ? "ok" : "no_result");
  if (result.status === "COMPLETED") return { status: "COMPLETED", reason };
  if (reason === "timeout" || reason === "hard_deadline") return { status: "TIMED_OUT", reason };
  return { status: result.status, reason };
}

function fingerprint(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function toSuggestion(candidate: DiscoveryCandidate, ctx: StageContext): Suggestion | null {
  // Each selected suggestion becomes one runnable scenario. Fixture paths are kept in its provenance.
  const requirement = `${candidate.goal}\nExpected behavior\n${candidate.expectedBehavior[0]}`;
  const instruction = [candidate.title, candidate.goal, candidate.rationale, ...candidate.expectedBehavior, ...candidate.negativeCases].join("\n");
  if (!assertActionAllowed({ instruction }, { allowDestructive: false }).allowed) return null;

  const parsed = SuggestionSchema.safeParse(ctx.redact({
    id: "S-1",
    title: candidate.title,
    requirement,
    why: candidate.rationale,
    needs: { secrets: [], testData: [] },
    destructive: false,
    discovery: { engine: "browser_use", relevantPaths: [...new Set(candidate.relevantPaths)] },
  }));
  return parsed.success ? parsed.data : null;
}

function mergeSurveySuggestions(
  draft: SuggestionSetDraft,
  candidates: DiscoveryCandidate[],
  ctx: StageContext,
): SuggestionSetDraft {
  const titles = new Set(draft.suggestions.map((suggestion) => fingerprint(suggestion.title)));
  const goals = new Set(draft.suggestions.map((suggestion) => fingerprint(suggestion.requirement)));
  const added: Suggestion[] = [];
  // Prefer candidates supported by multiple distinct fixture pages; ties preserve provider order.
  const ranked = candidates
    .map((candidate) => ({ candidate, depth: new Set(candidate.relevantPaths).size }))
    .sort((a, b) => b.depth - a.depth);
  const limit = MAX_SUGGESTIONS - Math.min(PRESERVED_SURVEY_COUNT, draft.suggestions.length);
  for (const { candidate } of ranked) {
    if (added.length === limit) break;
    const suggestion = toSuggestion(candidate, ctx);
    if (!suggestion) continue;
    const title = fingerprint(suggestion.title);
    const goal = fingerprint(candidate.goal);
    if (titles.has(title) || goals.has(goal)) continue;
    titles.add(title);
    goals.add(goal);
    added.push(suggestion);
  }
  if (added.length === 0) return draft;
  const suggestions = [
    ...draft.suggestions.slice(0, PRESERVED_SURVEY_COUNT),
    ...added,
    ...draft.suggestions.slice(PRESERVED_SURVEY_COUNT),
  ].slice(0, MAX_SUGGESTIONS).map((suggestion, index): Suggestion => ({ ...suggestion, id: `S-${index + 1}` }));
  return { ...draft, suggestions };
}

async function watchRollout(isEnabled: () => Promise<boolean>, stop: AbortSignal, revoked: AbortController): Promise<void> {
  while (!stop.aborted) {
    await delay(ROLLOUT_CHECK_MS, undefined, { signal: stop, ref: false }).catch(() => {});
    if (!stop.aborted && !(await isEnabled()) && !stop.aborted) {
      revoked.abort();
      return;
    }
  }
}

/**
 * Enrich only the real survey for the operator's disposable staging fixture. A run that did not opt in gets the
 * survey unchanged and no discovery events. An opted-in run always records one typed outcome (`discovery.completed`
 * or `discovery.failed`), including when this worker cannot run discovery at all.
 */
export function withAutonomousDiscovery(
  survey: EngineStages["survey"],
  discovery?: AutonomousSurveyDeps,
): EngineStages["survey"] {
  return async (ctx) => {
    const draft = await survey(ctx);
    const options = ctx.request.options;
    if (!options.autonomousDiscovery) return draft;

    const started = ctx.now().getTime();
    const finish = async (summary: DiscoverySummary) => {
      const completed = summary.status === "COMPLETED";
      discovery?.observe?.(summary, summary.attempted ? Math.max(0, (ctx.now().getTime() - started) / 1000) : null);
      await ctx.publish({ type: completed ? "discovery.completed" : "discovery.failed", message: MESSAGES[summary.status], payload: summary });
    };
    const fallback = (status: DiscoveryOutcomeStatus, reason: DiscoveryOutcomeReason, attempted: boolean): DiscoverySummary => ({
      status, reason, attempted, candidateCount: 0, acceptedCount: 0, pageCount: 0, fallbackUsed: true,
    });
    const skip = async (status: DiscoveryOutcomeStatus, reason: DiscoveryOutcomeReason) => {
      await finish(fallback(status, reason, false));
      return draft;
    };
    const isEnabled = async () => {
      try { return await discovery?.allowsTenant?.(ctx.tenantId) !== false; }
      catch { return false; }
    };

    if (!discovery?.port || !discovery.fixtureUrl) return skip("BLOCKED", "not_configured");
    if (ctx.request.environment !== "staging") return skip("BLOCKED", "environment");
    const target = DiscoveryFixtureUrlSchema.safeParse(ctx.request.targetUrl);
    if (!target.success || target.data !== discovery.fixtureUrl) return skip("BLOCKED", "fixture_mismatch");

    await ctx.boundary();
    if (!(await isEnabled())) return skip("BLOCKED", "tenant_disabled");
    const budgetMs = options.discoveryMaxSeconds ? options.discoveryMaxSeconds * 1000 : MAX_DISCOVERY_MS;
    const remaining = ctx.deadlineAt ? ctx.deadlineAt.getTime() - started - SURVEY_COMPLETION_MS : budgetMs;
    let stageMs = Math.min(remaining, budgetMs);
    let jobSeconds = Math.min(120, Math.floor(stageMs / 1000) - DISCOVERY_RESULT_GRACE_S);
    if (jobSeconds < MIN_JOB_SECONDS) return skip("TIMED_OUT", "no_budget");
    if (discovery.reserve && !(await discovery.reserve(ctx.tenantId))) return skip("BUSY", "tenant_quota");

    let admission: Extract<DiscoveryAdmission, { granted: true }> | undefined;
    if (discovery.admit) {
      const refund = async () => { await Promise.resolve(discovery.refund?.(ctx.tenantId)).catch(() => {}); };
      let granted: DiscoveryAdmission;
      try {
        granted = await discovery.admit({
          tenantId: ctx.tenantId, runId: ctx.runId, signal: ctx.signal,
          // Wait only as long as a minimum job still fits in the run's own discovery budget.
          maxWaitMs: (jobSeconds - MIN_JOB_SECONDS) * 1000,
          leaseMs: jobSeconds * 1000 + LEASE_GRACE_MS,
        });
      } catch {
        ctx.signal.throwIfAborted();
        await refund();
        return skip("BUSY", "capacity_wait");
      }
      if (!granted.granted) {
        await refund();
        return skip("BUSY", "capacity_wait");
      }
      admission = granted;
      stageMs -= granted.waitedMs;
      jobSeconds = Math.min(120, Math.floor(stageMs / 1000) - DISCOVERY_RESULT_GRACE_S);
      // A rollback while the run waited, or a wait that left too little time, ends here without a job.
      const blocked = !(await isEnabled()) ? "tenant_disabled" : jobSeconds < MIN_JOB_SECONDS ? "no_budget" : null;
      if (blocked) {
        await admission.release().catch(() => {});
        await refund();
        return blocked === "tenant_disabled" ? skip("BLOCKED", "tenant_disabled") : skip("TIMED_OUT", "no_budget");
      }
    }
    const targetUrl = target.data;
    try {
      return await runJob();
    } finally {
      await admission?.release().catch(() => {});
    }

    async function runJob() {
    if (!discovery?.port) return draft;

    const budgetSignal = ctx.budgetSignal(stageMs);
    const revoked = new AbortController();
    const resultReceived = new AbortController();
    const signal = AbortSignal.any([budgetSignal, revoked.signal]);
    await ctx.publish({ type: "discovery.started", message: "Browser Use discovery started", payload: { engine: "browser_use" } });
    if (discovery.allowsTenant) {
      void watchRollout(isEnabled, AbortSignal.any([signal, resultReceived.signal]), revoked);
    }
    let steps = 0;
    let result: DiscoveryResult | undefined;
    try {
      result = await discovery.port.discover(
        {
          schemaVersion: "discovery.v1", runId: ctx.runId, targetUrl, timeoutSeconds: jobSeconds,
          ...(options.discoveryMaxSteps === undefined ? {} : { maxAgentSteps: options.discoveryMaxSteps }),
        },
        { signal, onProgress: async (agentSteps) => {
          if (signal.aborted || agentSteps <= steps) return;
          steps = agentSteps;
          await ctx.publish({
            type: "discovery.progress", message: `Browser Use reached step ${agentSteps}`, payload: { agentSteps },
          });
        } },
      );
      signal.throwIfAborted();
      // A job can finish between polls. Recheck before offering any of its suggestions.
      if (discovery.allowsTenant && !(await isEnabled())) revoked.abort();
      signal.throwIfAborted();
    } catch (error) {
      ctx.signal.throwIfAborted();
      if (revoked.signal.aborted) {
        await finish({
          ...fallback("CANCELLED", "tenant_disabled", true),
          ...(result?.statistics && { statistics: result.statistics }),
        });
        return draft;
      }
      const failure = error instanceof DiscoveryPortError ? error.failure : null;
      discovery.logger?.warn({ runId: ctx.runId, failure: failure ?? (signal.aborted ? "deadline" : "unavailable") },
        "Browser Use discovery used the survey fallback");
      if (signal.aborted) await finish(fallback("TIMED_OUT", "worker_deadline", true));
      else if (failure === "busy") await finish(fallback("BUSY", "broker_busy", false));
      else if (failure === "invalid_result") await finish(fallback("FAILED", "invalid_result", true));
      else await finish(fallback("FAILED", "broker_unavailable", true));
      return draft;
    } finally {
      resultReceived.abort();
    }
    const merged = result.status === "COMPLETED" ? mergeSurveySuggestions(draft, result.candidates, ctx) : draft;
    const acceptedCount = merged.suggestions.filter((suggestion) => suggestion.discovery).length;
    const { status, reason } = classifyDiscoveryResult(result);
    if (status !== "COMPLETED") discovery.logger?.warn({ runId: ctx.runId, status, reason }, "Browser Use discovery used the survey fallback");
    await finish({
      status,
      reason,
      attempted: true,
      candidateCount: result.candidates.length,
      acceptedCount,
      pageCount: new Set(result.candidates.flatMap(({ relevantPaths }) => relevantPaths)).size,
      fallbackUsed: status !== "COMPLETED",
      ...(result.statistics && { statistics: result.statistics }),
    });
    return merged;
    }
  };
}
