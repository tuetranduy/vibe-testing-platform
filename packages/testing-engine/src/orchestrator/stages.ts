import {
  ContractError,
  type ExplorationOutcome,
  type ExplorationStep,
  type GeneratedTest,
  type NormalizedRequirement,
  type ProvisionalResult,
  type RerunResult,
  type SiteAnalysisDraft,
  type SitePage,
  type StoredTestRunRequest,
  type SuggestionSetDraft,
  type TestEventInput,
  type TestPlan,
  type TestReport,
} from "@platform/contracts";
import type { LlmClient } from "@platform/llm";

export type EventDraft = TestEventInput extends infer E ? (E extends unknown ? Omit<E, "runId" | "stage"> : never) : never;

/** Worker-only access to decrypted secrets. Values never go to a model or into persisted data. */
export interface SecretAccess {
  names: string[];
  get(name: string): string | undefined;
}

/**
 * What a stage can see. `signal` fires on cancel or hard deadline; its `reason` is a
 * CancelledError or DeadlineExceededError.
 */
export interface StageContext {
  runId: string;
  tenantId: string;
  request: StoredTestRunRequest;
  signal: AbortSignal;
  deadlineAt: Date | null;
  budgets: { explorationMs: number; rerunMs: number };
  secrets: SecretAccess;
  redact(value: unknown): unknown;
  publish(event: EventDraft): Promise<void>;
  /** Registers a resource to release in `finally` (browser, child process, ...). */
  addCleanup(fn: () => Promise<void> | void): void;
  /** Throws the abort reason if aborted; also checks the persisted cancel flag. Call at step boundaries. */
  boundary(): Promise<void>;
  /** A signal that fires after `ms` or when the run signal fires, whichever is first. */
  budgetSignal(ms: number): AbortSignal;
  now(): Date;
  /**
   * The run's model client: its recorded provider, model and reasoning level (the worker builds one per run).
   * Null only for runs on the fake engine, which makes no model call.
   */
  llm: LlmClient | null;
}

/** The run's model client, for a real stage; a run without one (the fake engine's choice) is a contract error. */
export function requireLlm(ctx: Pick<StageContext, "llm">): LlmClient {
  if (!ctx.llm) throw new ContractError("This run has no model client: the real engine cannot run it");
  return ctx.llm;
}

export type RequirementDraft = Omit<NormalizedRequirement, "runId" | "revision" | "confirmedAt">;

/**
 * What `analyze` returns: the draft, and (V1.3) its analysis against the live site — the pages read, the
 * per-criterion site checks and the suggested test data. The orchestrator stores the two apart.
 */
export type AnalyzedRequirement = RequirementDraft & { siteAnalysis?: SiteAnalysisDraft };

export interface GenerateTestInput {
  requirement: NormalizedRequirement;
  plan: TestPlan;
  exploration: ExplorationOutcome;
  provisional: ProvisionalResult[];
}

export interface ReportInput {
  requirement: NormalizedRequirement;
  plan: TestPlan;
  exploration: ExplorationOutcome | null;
  provisional: ProvisionalResult[];
  generatedTest: GeneratedTest | null;
  rerun: RerunResult | null;
  startedAt: Date | null;
}

export interface EngineStages {
  /**
   * A blank requirement (spec 2026-09-28-suggest-tests): survey the website read-only and propose
   * tests. Publishes `page.surveyed` / `artifact.created` itself; the orchestrator stores the set.
   */
  survey(ctx: StageContext): Promise<SuggestionSetDraft>;
  analyze(ctx: StageContext): Promise<AnalyzedRequirement>;
  /** `site`: the pages the analysis read (KI-048); empty when none were read. */
  plan(ctx: StageContext, requirement: NormalizedRequirement, site: SitePage[]): Promise<TestPlan>;
  /** Must return (not throw) when the exploration budget or step limit is exhausted. */
  explore(ctx: StageContext, plan: TestPlan, requirement: NormalizedRequirement): Promise<ExplorationOutcome>;
  verify(
    ctx: StageContext,
    requirement: NormalizedRequirement,
    plan: TestPlan,
    exploration: ExplorationOutcome | null,
  ): ProvisionalResult[];
  generateTest(ctx: StageContext, input: GenerateTestInput): Promise<GeneratedTest | null>;
  runTest(ctx: StageContext, test: GeneratedTest): Promise<RerunResult>;
  report(ctx: StageContext, input: ReportInput): Promise<TestReport>;
  /**
   * V1.3: every criterion is blocked before exploration, so nothing would be seen of the site. Loads the start
   * page read-only (no model) and keeps a full-page screenshot as the blocked criteria's evidence, recorded as
   * a `screenshot` step. Best effort: returns [] when it cannot. Optional (absent: no evidence).
   */
  captureEvidence?(ctx: StageContext): Promise<ExplorationStep[]>;
}
