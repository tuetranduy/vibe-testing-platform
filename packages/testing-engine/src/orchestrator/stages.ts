import type {
  ExplorationOutcome,
  GeneratedTest,
  NormalizedRequirement,
  ProvisionalResult,
  RerunResult,
  StoredTestRunRequest,
  TestEventInput,
  TestPlan,
  TestReport,
} from "@platform/contracts";

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
}

export type RequirementDraft = Omit<NormalizedRequirement, "runId" | "revision" | "confirmedAt">;

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
  analyze(ctx: StageContext): Promise<RequirementDraft>;
  plan(ctx: StageContext, requirement: NormalizedRequirement): Promise<TestPlan>;
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
}
