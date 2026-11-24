import { setTimeout as delay } from "node:timers/promises";
import {
  DiscoveryFixtureUrlSchema,
  DiscoveryLiveUrlSchema,
  MAX_DISCOVERY_FINDINGS,
  type DiscoveryCandidate,
  type DiscoveryFindingCandidate,
  type DiscoveryInput,
  type DiscoveryModel,
  type DiscoveryOutcomeReason,
  type DiscoveryOutcomeStatus,
  type DiscoveryResult,
  type DiscoverySummary,
  type SitePage,
  type SuggestionSetDraft,
} from "@platform/contracts";
import type { StageContext } from "../orchestrator/stages";
import { DiscoveryPortError, type AutonomousDiscoveryPort } from "./port";

/** Three agents' candidates together (each returns at most 12). */
const MAX_MERGED_CANDIDATES = 36;

const MAX_DISCOVERY_MS = 120_000;
// Leave time for the existing orchestrator to save and publish its result after a timeout.
const STAGE_COMPLETION_MS = 5_000;
/**
 * The broker's whole job budget ends this long before the stage's own deadline, so its typed timeout or partial
 * reply arrives before the stage stops waiting (the launcher stops its container within the job budget).
 */
export const DISCOVERY_RESULT_GRACE_S = 5;
const MIN_JOB_SECONDS = 10;
const ROLLOUT_CHECK_MS = 2_000;
// After the broker's job budget: its container cleanup (≤ 18 s) and a margin, before a lost lease frees itself.
const LEASE_GRACE_MS = 30_000;

export type DiscoverySnapshot = NonNullable<DiscoveryInput["snapshot"]>;

export interface DiscoveryAdmissionRequest {
  tenantId: string;
  runId: string;
  maxWaitMs: number;
  /** The lease ends by itself after this long: the job's whole budget plus a grace period. */
  leaseMs: number;
  signal: AbortSignal;
}
export type DiscoveryAdmission = { granted: true; waitedMs: number; release(): Promise<void> } | { granted: false; waitedMs: number };

/** The Browser Use wiring a worker gives the stages that can run discovery (the survey and, Phase B, the analysis). */
export interface AutonomousSurveyDeps {
  /** Both absent: this worker has no discovery transport; opted-in runs record BLOCKED / not_configured. */
  fixtureUrl?: string;
  port?: AutonomousDiscoveryPort;
  prepareVerifiedSite?: (ctx: StageContext) => Promise<{ draft: SuggestionSetDraft; snapshot: DiscoverySnapshot }>;
  /**
   * Live sites: the broker can let the agent interact with the real site through its job's inspecting egress
   * proxy (clicks, menus, form validation; nothing that sends data). Absent: live sites use snapshots only.
   */
  liveInteraction?: boolean;
  /** Phase B, live-site mode: the pages and their snapshot without the survey's own test ideas. */
  readVerifiedSite?: (ctx: StageContext) => Promise<{ pages: SitePage[]; snapshot: DiscoverySnapshot }>;
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
  /**
   * Phase C: stores a completed job's exploratory findings as unverified hypotheses, apart from every verdict.
   * Absent: findings are dropped. A storage failure never changes the discovery outcome.
   */
  recordFindings?: (ctx: StageContext, findings: DiscoveryFindingCandidate[]) => Promise<number>;
  /**
   * The run's own model and its Settings key, as the run's other stages use it. Absent: the broker's own model.
   * Throws when the run's provider has no key: the run records BLOCKED / model_not_configured.
   */
  modelFor?: (ctx: StageContext) => Promise<DiscoveryModel | null>;
  /** Every opted-in run's outcome; `elapsedSeconds` is null when no broker job was attempted. */
  observe?: (summary: DiscoverySummary, elapsedSeconds: number | null) => void;
  logger?: { warn(obj: object, message: string): void };
}

export interface DiscoveryJobOptions<T> {
  /** Live-site mode: the job reads `snapshot` offline; the run's own URL is never sent to the broker. */
  verified: boolean;
  snapshot?: DiscoverySnapshot;
  /** Phase B: the run's (redacted) requirement, so the agent looks for routes that exercise it. */
  focus?: string;
  /** The caller already claimed the tenant's quota attempt (the live-site survey does, before reading the site). */
  reserved?: boolean;
  /** Live-site mode: the agent works on the real site (`liveInteraction`) instead of the offline snapshot. */
  live?: boolean;
  /**
   * Phase C, multi-agent exploration: up to this many agents (the run's `discoveryAgents`, at most 3), each in its
   * own container with its own broker job, admission slot and quota attempt, each told to concentrate on one of
   * `areas`. An agent that gets no slot is simply not started; the first one alone decides whether a job runs.
   */
  agents?: number;
  areas?: readonly { path: string; title: string }[];
  /** Exploration-time recovery: no discovery events (the run's discovery outcome stays the survey's or analysis'). */
  quiet?: boolean;
  /** A second job in one run needs its own broker job id: `<runId>-<jobId>`. */
  jobId?: string;
  maxSeconds?: number;
  maxSteps?: number;
  /** Turns a completed job's candidates into the stage's value; `acceptedCount` is what the stage kept. */
  accept(candidates: DiscoveryCandidate[]): { value: T | null; acceptedCount: number };
  /** The stage's fallback, for the user-facing messages ("Showing standard survey suggestions."). */
  fallbackLabel: string;
}

const messages = (label: string): Record<DiscoveryOutcomeStatus, string> => ({
  COMPLETED: "Browser Use discovery finished",
  PARTIAL: `Browser Use returned no reviewable ideas. ${label}`,
  TIMED_OUT: `Browser Use reached its time limit. ${label}`,
  BUSY: `Browser Use was busy with other runs. ${label}`,
  BLOCKED: `Browser Use is not available for this run. ${label}`,
  FAILED: `Browser Use was unavailable. ${label}`,
  CANCELLED: `Browser Use stopped before it finished. ${label}`,
});

/** The broker's status and reason, as the platform classifies them: a time limit is TIMED_OUT, not a failure. */
export function classifyDiscoveryResult(result: DiscoveryResult): { status: DiscoveryOutcomeStatus; reason: DiscoveryOutcomeReason } {
  const reason = result.reason ?? (result.status === "COMPLETED" ? "ok" : "no_result");
  if (result.status === "COMPLETED") return { status: "COMPLETED", reason };
  if (reason === "timeout" || reason === "hard_deadline") return { status: "TIMED_OUT", reason };
  return { status: result.status, reason };
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
 * One opted-in run's Browser Use job: the admission gates (transport, environment, fixture, rollout, budget, quota,
 * fair capacity), the job itself with progress and in-flight rollback, and exactly one typed outcome event
 * (`discovery.completed` or `discovery.failed`). Returns the stage's value from `accept`, or null whenever the
 * stage should use its own result unchanged. Only cancellation and the run's hard deadline throw.
 */
export async function runDiscoveryJob<T>(
  ctx: StageContext,
  discovery: AutonomousSurveyDeps | undefined,
  options: DiscoveryJobOptions<T>,
): Promise<{ value: T | null; summary: DiscoverySummary }> {
  const { verified, snapshot, focus } = options;
  const runOptions = ctx.request.options;
  const MESSAGES = messages(options.fallbackLabel);
  const started = ctx.now().getTime();
  const publish = options.quiet ? async () => {} : (event: Parameters<StageContext["publish"]>[0]) => ctx.publish(event);
  const baseRunId = options.jobId ? `${ctx.runId}-${options.jobId}` : ctx.runId;
  const finish = async (summary: DiscoverySummary) => {
    const completed = summary.status === "COMPLETED";
    discovery?.observe?.(summary, summary.attempted ? Math.max(0, (ctx.now().getTime() - started) / 1000) : null);
    await publish({ type: completed ? "discovery.completed" : "discovery.failed", message: MESSAGES[summary.status], payload: summary });
    return summary;
  };
  const fallback = (status: DiscoveryOutcomeStatus, reason: DiscoveryOutcomeReason, attempted: boolean): DiscoverySummary => ({
    status, reason, attempted, candidateCount: 0, acceptedCount: 0, pageCount: 0, fallbackUsed: true,
  });
  const skip = async (status: DiscoveryOutcomeStatus, reason: DiscoveryOutcomeReason) =>
    ({ value: null, summary: await finish(fallback(status, reason, false)) });
  const isEnabled = async () => {
    try { return verified || await discovery?.allowsTenant?.(ctx.tenantId) !== false; }
    catch { return false; }
  };

  const live = verified && options.live === true;
  if (!discovery?.port || !discovery.fixtureUrl || (live && !discovery.liveInteraction)) return skip("BLOCKED", "not_configured");
  if (!verified && ctx.request.environment !== "staging") return skip("BLOCKED", "environment");
  let targetUrl: string;
  if (live) {
    const page = DiscoveryLiveUrlSchema.safeParse(ctx.request.targetUrl);
    if (!page.success) return skip("BLOCKED", "fixture_mismatch");
    targetUrl = page.data.href;
  } else {
    const target = DiscoveryFixtureUrlSchema.safeParse(verified ? discovery.fixtureUrl : ctx.request.targetUrl);
    if (!target.success || target.data !== discovery.fixtureUrl) return skip("BLOCKED", "fixture_mismatch");
    targetUrl = target.data;
  }

  await ctx.boundary();
  if (!(await isEnabled())) return skip("BLOCKED", "tenant_disabled");
  let model: DiscoveryModel | null = null;
  if (discovery.modelFor) {
    try {
      model = await discovery.modelFor(ctx);
    } catch {
      ctx.signal.throwIfAborted();
      return skip("BLOCKED", "model_not_configured");
    }
  }
  const budgetMs = options.maxSeconds ? options.maxSeconds * 1000 : runOptions.discoveryMaxSeconds ? runOptions.discoveryMaxSeconds * 1000 : MAX_DISCOVERY_MS;
  const remaining = ctx.deadlineAt ? ctx.deadlineAt.getTime() - started - STAGE_COMPLETION_MS : budgetMs;
  let stageMs = Math.min(remaining, budgetMs);
  let jobSeconds = Math.min(120, Math.floor(stageMs / 1000) - DISCOVERY_RESULT_GRACE_S);
  if (jobSeconds < MIN_JOB_SECONDS) return skip("TIMED_OUT", "no_budget");
  if (!options.reserved && discovery.reserve && !(await discovery.reserve(ctx.tenantId))) return skip("BUSY", "tenant_quota");

  let admission: Extract<DiscoveryAdmission, { granted: true }> | undefined;
  if (discovery.admit) {
    const refund = async () => {
      if (!options.reserved) await Promise.resolve(discovery.refund?.(ctx.tenantId)).catch(() => {});
    };
    let granted: DiscoveryAdmission;
    try {
      granted = await discovery.admit({
        tenantId: ctx.tenantId, runId: baseRunId, signal: ctx.signal,
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
  const port = discovery.port;
  // Extra agents (Phase C): each takes a free slot at once and its own quota attempt, or is not started.
  const extras: { runId: string; focus: string; release?: () => Promise<void> }[] = [];
  const areas = options.areas ?? [];
  const wanted = Math.min(3, Math.max(1, options.agents ?? 1), 1 + areas.length);
  for (let i = 1; i < wanted && discovery.admit; i++) {
    const runId = `${baseRunId}-a${i + 1}`;
    if (discovery.reserve && !(await discovery.reserve(ctx.tenantId))) break;
    const granted = await discovery.admit({
      tenantId: ctx.tenantId, runId, signal: ctx.signal, maxWaitMs: 0, leaseMs: jobSeconds * 1000 + LEASE_GRACE_MS,
    }).catch(() => ({ granted: false as const, waitedMs: 0 }));
    if (!granted.granted) {
      await Promise.resolve(discovery.refund?.(ctx.tenantId)).catch(() => {});
      break;
    }
    const area = areas[i - 1]!;
    extras.push({ runId, release: granted.release, focus: agentFocus(focus, area) });
  }
  try {
    return await runJob();
  } finally {
    await admission?.release().catch(() => {});
    for (const extra of extras) await extra.release?.().catch(() => {});
  }

  async function runJob(): Promise<{ value: T | null; summary: DiscoverySummary }> {
    const budgetSignal = ctx.budgetSignal(stageMs);
    const revoked = new AbortController();
    const resultReceived = new AbortController();
    const signal = AbortSignal.any([budgetSignal, revoked.signal]);
    await publish({ type: "discovery.started", message: "Browser Use discovery started", payload: { engine: "browser_use" } });
    if (discovery!.allowsTenant) {
      void watchRollout(isEnabled, AbortSignal.any([signal, resultReceived.signal]), revoked);
    }
    let steps = 0;
    const agentSteps = new Map<string, number>();
    const maxSteps = options.maxSteps ?? runOptions.discoveryMaxSteps;
    const agents = [{ runId: baseRunId, focus }, ...extras];
    const job = (agent: { runId: string; focus?: string }) => port.discover(
      {
        schemaVersion: "discovery.v1", runId: agent.runId, targetUrl, timeoutSeconds: jobSeconds,
        ...(maxSteps === undefined ? {} : { maxAgentSteps: maxSteps }),
        ...(live ? { live: true as const } : snapshot && { snapshot }),
        ...(agent.focus && { focus: agent.focus }),
        ...(model && { model }),
      },
      { signal, onProgress: async (reached) => {
        if (signal.aborted) return;
        agentSteps.set(agent.runId, Math.max(agentSteps.get(agent.runId) ?? 0, reached));
        const total = Math.min(60, [...agentSteps.values()].reduce((a, b) => a + b, 0));
        if (total <= steps) return;
        steps = total;
        await publish({
          type: "discovery.progress", message: `Browser Use reached step ${total}`, payload: { agentSteps: total },
        });
      } },
    );
    let result: DiscoveryResult | undefined;
    try {
      const settled = await Promise.allSettled(agents.map(job));
      result = mergeAgentResults(baseRunId, settled);
      signal.throwIfAborted();
      // A job can finish between polls. Recheck before offering any of its results.
      if (discovery!.allowsTenant && !(await isEnabled())) revoked.abort();
      signal.throwIfAborted();
    } catch (error) {
      ctx.signal.throwIfAborted();
      if (revoked.signal.aborted) {
        return {
          value: null,
          summary: await finish({
            ...fallback("CANCELLED", "tenant_disabled", true),
            ...(result?.statistics && { statistics: result.statistics }),
          }),
        };
      }
      const failure = error instanceof DiscoveryPortError ? error.failure : null;
      discovery!.logger?.warn({ runId: ctx.runId, failure: failure ?? (signal.aborted ? "deadline" : "unavailable") },
        "Browser Use discovery used the survey fallback");
      const summary = signal.aborted ? fallback("TIMED_OUT", "worker_deadline", true)
        : failure === "busy" ? fallback("BUSY", "broker_busy", false)
        : failure === "invalid_result" ? fallback("FAILED", "invalid_result", true)
        : fallback("FAILED", "broker_unavailable", true);
      return { value: null, summary: await finish(summary) };
    } finally {
      resultReceived.abort();
    }
    const accepted = result.status === "COMPLETED" ? options.accept(result.candidates) : { value: null, acceptedCount: 0 };
    const { status, reason } = classifyDiscoveryResult(result);
    if (status !== "COMPLETED") discovery!.logger?.warn({ runId: ctx.runId, status, reason }, "Browser Use discovery used the survey fallback");
    let findingCount: number | undefined;
    if (result.status === "COMPLETED" && result.findings?.length && discovery!.recordFindings) {
      try {
        findingCount = await discovery!.recordFindings(ctx, result.findings);
      } catch (error) {
        ctx.signal.throwIfAborted();
        discovery!.logger?.warn({ runId: ctx.runId, err: error instanceof Error ? error.message : String(error) },
          "Browser Use findings could not be stored");
      }
    }
    const summary = await finish({
      status,
      reason,
      attempted: true,
      candidateCount: result.candidates.length,
      acceptedCount: accepted.acceptedCount,
      pageCount: new Set(result.candidates.flatMap(({ relevantPaths }) => relevantPaths)).size,
      fallbackUsed: status !== "COMPLETED",
      ...(findingCount !== undefined && { findingCount }),
      ...(agents.length > 1 && { agents: agents.length }),
      ...(result.statistics && { statistics: result.statistics }),
    });
    return { value: accepted.value, summary };
  }
}

/** An extra agent's focus: the run's own (a requirement) and the one area it concentrates on. */
function agentFocus(focus: string | undefined, area: { path: string; title: string }): string {
  const where = `Concentrate on the ${area.title ? `"${area.title.slice(0, 80)}" ` : ""}page (${area.path}) and the flows that start there.`;
  return (focus ? `${focus} ${where}` : where).replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim().slice(0, 1000);
}

const sum = (values: (number | null | undefined)[]) => values.reduce<number>((a, b) => a + (b ?? 0), 0);

/**
 * The agents' replies as one result. Any completed agent makes it COMPLETED with every completed agent's
 * candidates and (deduplicated) findings; otherwise the first agent's own reply or error stands. Statistics add up
 * (time is the longest agent's). An agent the broker refused as busy is not counted.
 */
export function mergeAgentResults(runId: string, settled: PromiseSettledResult<DiscoveryResult>[]): DiscoveryResult {
  const replies = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
  const completed = replies.filter((r): r is Extract<DiscoveryResult, { status: "COMPLETED" }> => r.status === "COMPLETED");
  if (settled.length === 1 || completed.length === 0) {
    const first = settled[0]!;
    if (first.status === "rejected") throw first.reason;
    return first.value;
  }
  const stats = replies.flatMap((r) => (r.statistics ? [r.statistics] : []));
  const seen = new Set<string>();
  const findings = completed.flatMap((r) => r.findings ?? []).filter((f) => {
    const key = `${f.path}|${f.title.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MAX_DISCOVERY_FINDINGS);
  const known = stats.filter((s) => s.modelCostUsd !== null);
  return {
    schemaVersion: "discovery.v1", runId, status: "COMPLETED", reason: "ok",
    candidates: completed.flatMap((r) => r.candidates).slice(0, MAX_MERGED_CANDIDATES),
    ...(findings.length > 0 && { findings }),
    ...(stats.length > 0 && {
      statistics: {
        agentSteps: Math.min(60, sum(stats.map((s) => s.agentSteps))),
        modelRequests: Math.min(60, sum(stats.map((s) => s.modelRequests))),
        durationMs: Math.max(...stats.map((s) => s.durationMs)),
        inputTokens: sum(stats.map((s) => s.inputTokens)),
        outputTokens: Math.min(1_000_000, sum(stats.map((s) => s.outputTokens))),
        modelCostUsd: known.length === stats.length ? sum(known.map((s) => s.modelCostUsd)) : null,
        protocolViolations: sum(stats.map((s) => s.protocolViolations)),
        peakMemoryBytes: stats.some((s) => s.peakMemoryBytes != null) ? Math.max(...stats.map((s) => s.peakMemoryBytes ?? 0)) : null,
        blockedDestinations: stats.some((s) => s.blockedDestinations != null) ? sum(stats.map((s) => s.blockedDestinations)) : null,
        blockedByReason: stats.some((s) => s.blockedByReason) ? stats.reduce<Record<string, number>>((all, s) => {
          for (const [reason, count] of Object.entries(s.blockedByReason ?? {})) all[reason] = (all[reason] ?? 0) + (count ?? 0);
          return all;
        }, {}) : null,
      },
    }),
  };
}
