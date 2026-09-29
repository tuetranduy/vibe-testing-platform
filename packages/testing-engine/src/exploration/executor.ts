import { randomBytes } from "node:crypto";
import {
  BrowserProviderError,
  CancelledError,
  EngineError,
  ExplorationStepSchema,
  ObservedFactSchema,
  type ArtifactSensitivity,
  type BlockReason,
  type CachedElement,
  type ElementRef,
  type ExplorationOutcome,
  type ExplorationStep,
  type ExplorationStopReason,
  type FactRequest,
  type FactValue,
  type InputRef,
  type NormalizedRequirement,
  type ObservedFact,
  type PlannedStep,
  type TestPlan,
} from "@platform/contracts";
import { assertActionAllowed, type ActionPolicy } from "@platform/security";
import {
  ExplorerSessionClosedError,
  NavigationBlockedError,
  type ExplorerSession,
  type LlmStepUsage,
  type ObservedElement,
} from "@platform/stagehand-adapter/browser-explorer";
import type { Page } from "playwright-core";
import { z } from "zod";
import type { StageContext } from "../orchestrator/stages";
import { actionPolicyFor, isDestructiveStep } from "../shared/action-policy";
import { captureFact, factFromReadings, modeForValueType, urlFact, type FactCaptureInput, type FactReadMode } from "./fact-reader";
import { observeCacheKey, type CacheWhere, type ObserveCache } from "./observe-cache";
import { describeElement, fillElement, recordElement, selectElementOption } from "./recorder";

/**
 * Exploration executor (Task 14): runs the confirmed plan's single scenario (D12) through an
 * `ExplorerSession` and records replayable `ExplorationStep`s and `ObservedFact`s.
 *
 * Planned step kind → what runs (and what is recorded):
 *
 * - (start)      The first action navigates to `request.targetUrl` (`session.navigate`, kind
 *                `navigate`). If the first planned step is a `navigate` with no URL, or with the
 *                target URL, this navigation *is* that step; otherwise it is recorded with
 *                `plannedStepId: null` (still on the golden path: the compiler opens the target).
 * - navigate     A URL in the description (absolute `http(s)://…`, or a path `/…` resolved against the
 *                target) → `session.navigate(url)` (kind `navigate`, instruction `Navigate to <url>`).
 *                No URL → like `click` on the described link.
 * - click, submit, login, other, navigate-by-link
 *                `observe(description)` → first element → recorder: ElementRef + role/name/text →
 *                `assertActionAllowed` (instruction + element; the run's
 *                `actionPolicyFor`, D9 amended; a planner `destructive: true` also blocks; with
 *                destructive actions allowed, a destructive element only for a destructive step) → `actOn(element)` with method `click` and no
 *                arguments (deterministic, zero model calls; model-chosen arguments are never
 *                replayed). `other` may keep a non-value method (hover, double click, scroll into
 *                view). Recorded: `observe` + `act`.
 * - fill         Value from `inputRef` (testData / secret via `ctx.secrets.get` / literal) →
 *                `observe(description)` → policy check → the recorder's deterministic `fill`.
 *                Recorded: `observe` + `fill` (with `inputRef`, never the value). The model never
 *                types: no value is ever passed to `act()` / `actOn()`.
 * - select       With `inputRef`: like `fill`, but the recorder selects the option (recorded as kind
 *                `fill`; the compiler tells it apart by the planned step's kind). Without: like `click`.
 * - search       `fill` of the query, then the search's submit control is observed and clicked (an
 *                observe that returns the filled field fails the attempt: clicking it submits
 *                nothing). The fill is golden only when the submit succeeds in the same attempt (its steps are
 *                persisted after the attempt, with their final flags).
 * - capture_checkpoint
 *                One `extract` of every FactRequest at that checkpoint (model values) → for each fact
 *                with a DOM read mode, `observe` its element → recorder `captureFact` (DOM_VERIFIED
 *                when the DOM agrees, else MODEL_EXTRACTED). Read mode = `modeForValueType`, except
 *                a boolean is read as `visible` only when a `visible` outcome references that
 *                (key, checkpoint), else it has no DOM read (Ruling R24). The reserved `url` fact
 *                comes first. Then a screenshot artifact. Recorded: `extract`, `observe`s, and the
 *                `checkpoint` step the facts point at (`stepId`, `artifactIds`).
 * - wait_for     Bounded poll: up to 3 `observe`s, `pollIntervalMs` apart, within the budget.
 *
 * Golden path: `onGoldenPath = true` only for the successful execution of a planned step (the
 * `navigate` / `act` / `fill` / `checkpoint` step); observes, extracts, retries and failed attempts
 * are false. A planned step gets at most one retry; if it still fails, exploration stops (later
 * checkpoints would describe a flow that did not happen) and the missing facts end INCONCLUSIVE.
 *
 * Stops: BLOCKED_BY_POLICY (missing secret / test data, destructive action, blocked navigation;
 * the blocked step is recorded and never executed), STEP_LIMIT_REACHED (`maxExplorationSteps`
 * recorded steps; no operation starts that could not be recorded), EXPLORATION_BUDGET_EXHAUSTED
 * (the budget signal; returned, not thrown). Cancel / hard deadline throw the abort reason. Model,
 * contract and storage errors are infrastructure errors and propagate. The session is always closed.
 *
 * Secrets (D7): every persisted row, published event, error text and every string passed to the
 * explorer goes through `ctx.redact` first; values are filled only by our recorder.
 *
 * Exploration cache (V1.1 F8, `deps.cache`): before an `observe`, the lookup of the same instruction on the
 * same page (origin + path) from an earlier run is tried. It is reused only when its selector still
 * resolves to an element whose chosen locator is the one recorded then; the step is recorded as an
 * `observe` with `llm.cacheHit: true` and no tokens. The action policy checks the element either way. A new
 * lookup is written only once the planned step that used it succeeded, so a failed, blocked or retried
 * attempt never populates the cache. A failing cache is a miss.
 */

/** Persistence ports (Ruling R12), implemented by the worker. Rows arrive validated and redacted. */
export interface ExplorationStore {
  saveStep(step: ExplorationStep): Promise<void>;
  saveFact(fact: ObservedFact): Promise<void>;
  /** Stores a PNG in artifact storage and its row; returns the artifact id. */
  saveScreenshot(input: { png: Buffer; fileName: string; sensitivity: ArtifactSensitivity }): Promise<{ artifactId: string }>;
}

/** Deterministic page access (DOM reads, our own fills). The default is the Playwright recorder. */
export interface RecorderPort {
  describe(page: Page, selector: string): Promise<{ role: string | null; name: string | null; text: string | null }>;
  record(page: Page, selector: string): Promise<ElementRef>;
  fill(page: Page, selector: string, value: string): Promise<void>;
  select(page: Page, selector: string, value: string): Promise<void>;
  captureFact(page: Page, input: FactCaptureInput): Promise<ObservedFact>;
}

export const playwrightRecorder: RecorderPort = {
  async describe(page, selector) {
    const d = await describeElement(page, selector);
    return { role: d.role, name: d.name, text: d.text };
  },
  record: (page, selector) => recordElement(page, selector),
  fill: (page, selector, value) => fillElement(page, selector, value),
  select: (page, selector, value) => selectElementOption(page, selector, value),
  captureFact: (page, input) => captureFact(page, input),
};

export interface ExplorationInput {
  plan: TestPlan;
  requirement: NormalizedRequirement;
  /** Started with `signal: budget`, so an operation in flight stops when the budget runs out. */
  session: ExplorerSession;
  /** `ctx.budgetSignal(ctx.budgets.explorationMs)`. */
  budget: AbortSignal;
}

export interface ExplorationDeps {
  store: ExplorationStore;
  recorder?: RecorderPort;
  /** Delay between `wait_for` polls. */
  pollIntervalMs?: number;
  /** Cached element lookups from earlier runs (V1.1 F8); absent: every lookup asks the explorer. */
  cache?: ObserveCache;
}

const MAX_ATTEMPTS = 2; // one retry per planned step
const WAIT_FOR_POLLS = 3;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const LOAD_SETTLE_TIMEOUT_MS = 10_000;
/** `other` steps may keep these observed methods (none takes a value); everything else clicks. */
const SAFE_OTHER_METHODS = new Set(["click", "doubleClick", "hover", "scrollIntoView"]);
/** Term matching regardless of what the run allows: what the step and the element are, not what may run. */
const DENY_DESTRUCTIVE: ActionPolicy = { allowDestructive: false };

const OUTCOME_LABEL: Record<ExplorationStep["outcome"], string> = {
  SUCCESS: "succeeded",
  FAILED: "failed",
  BLOCKED_BY_POLICY: "blocked by policy",
};

/** Ends exploration with a stop reason (internal control flow). */
class Stop {
  constructor(readonly reason: ExplorationStopReason) {}
}

type Attempt = "ok" | "failed" | "final";

interface StepDraft {
  id?: string;
  plannedStepId: string | null;
  kind: ExplorationStep["kind"];
  instruction: string;
  element?: ElementRef | null;
  inputRef?: InputRef | null;
  onGoldenPath?: boolean;
  urlBefore: string;
  outcome: ExplorationStep["outcome"];
  blockReason?: BlockReason | null;
  error?: string | null;
  startedAt: Date;
  artifactIds?: string[];
  llm?: LlmStepUsage | null;
}

interface Located {
  element: ObservedElement;
  ref: ElementRef;
  info: { role: string | null; name: string | null; text: string | null };
}

export function newStepId(): string {
  return `step_${Date.now().toString(36)}${randomBytes(6).toString("hex")}`;
}

const firstLine = (err: unknown): string => {
  const msg = err instanceof Error ? err.message : String(err);
  return (msg.split("\n")[0] ?? "").slice(0, 500);
};

const TRAILING_PUNCTUATION = /[.,;:!?)\]'"]+$/;

/** The URL a navigate step names: absolute http(s), or a path resolved against the target. Null if none. */
export function urlInDescription(description: string, targetUrl: string): string | null {
  const absolute = /\bhttps?:\/\/[^\s"'<>`]+/i.exec(description)?.[0];
  const relative = absolute ? undefined : /(?:^|\s)(\/[^\s"'<>`]*)/.exec(description)?.[1];
  const raw = (absolute ?? relative)?.replace(TRAILING_PUNCTUATION, "");
  if (!raw) return null;
  try {
    return new URL(raw, targetUrl).href;
  } catch {
    return null;
  }
}

const sameUrl = (a: string, b: string): boolean => {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
};

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Errors that end the run as ERRORED (or CANCELLED) instead of failing one step. */
function isFatal(err: unknown): boolean {
  if (err instanceof CancelledError) return true;
  if (err instanceof EngineError) return !(err instanceof BrowserProviderError);
  return (err as { name?: unknown } | null)?.name === "StorageError";
}

function valueSchema(valueType: FactRequest["valueType"]): z.ZodType<FactValue> {
  switch (valueType) {
    case "number":
      return z.number().nullable();
    case "string":
      return z.string().nullable();
    case "boolean":
      return z.boolean().nullable();
    case "string_list":
      return z.array(z.string()).nullable();
  }
}

class ExplorationRun {
  private readonly steps: ExplorationStep[] = [];
  private readonly facts: ObservedFact[] = [];
  /** Steps of an execution in progress whose golden flag depends on its outcome (see `asOneExecution`). */
  private held: ExplorationStep[] | null = null;
  /** New lookups of the planned step in progress, written to the cache only if it succeeds. */
  private cacheWrites: { key: string; where: CacheWhere; entry: CachedElement }[] = [];
  private readonly session: ExplorerSession;
  private readonly recorder: RecorderPort;
  private readonly policy: ActionPolicy;
  private readonly sensitivity: ArtifactSensitivity;
  private readonly max: number;
  private readonly visibleFacts: Set<string>;

  constructor(
    private readonly ctx: StageContext,
    private readonly input: ExplorationInput,
    private readonly deps: ExplorationDeps,
  ) {
    const { request } = ctx;
    this.session = input.session;
    this.recorder = deps.recorder ?? playwrightRecorder;
    this.policy = actionPolicyFor(request);
    this.sensitivity = ctx.secrets.names.length > 0 || request.secretNames.length > 0 ? "SECRET_BEARING" : "STANDARD";
    this.max = request.options.maxExplorationSteps;
    this.visibleFacts = new Set(
      input.requirement.criteria.flatMap((c) =>
        c.expectedOutcome.kind === "visible" ? [`${c.expectedOutcome.fact.key}@${c.expectedOutcome.fact.checkpoint}`] : [],
      ),
    );
  }

  private get page(): Page {
    return this.session.page;
  }

  private url(): string {
    try {
      return this.page.url();
    } catch {
      return "about:blank";
    }
  }

  async execute(): Promise<ExplorationOutcome> {
    let stopReason: ExplorationStopReason = "COMPLETED";
    try {
      const planned = this.input.plan.scenarios[0]?.steps ?? [];
      const targetUrl = this.ctx.request.targetUrl;
      const first = planned[0];
      const firstUrl = first?.kind === "navigate" ? urlInDescription(first.description, targetUrl) : null;
      const opensTarget = first?.kind === "navigate" && (firstUrl === null || sameUrl(firstUrl, targetUrl));

      await this.ctx.boundary();
      await this.withRetry(() => this.navigate(targetUrl, opensTarget ? first : null));
      for (const step of planned.slice(opensTarget ? 1 : 0)) {
        await this.ctx.boundary();
        await this.executePlanned(step);
      }
    } catch (err) {
      if (err instanceof Stop) stopReason = err.reason;
      else if (this.ctx.signal.aborted) throw this.ctx.signal.reason;
      else throw err;
    }
    return { steps: [...this.steps], facts: [...this.facts], stopReason };
  }

  // -------------------------------------------------------------------------------------------
  // Planned steps
  // -------------------------------------------------------------------------------------------

  private async executePlanned(step: PlannedStep): Promise<void> {
    switch (step.kind) {
      case "navigate": {
        const url = urlInDescription(step.description, this.ctx.request.targetUrl);
        return this.withRetry(() => (url ? this.navigate(url, step) : this.act(step)));
      }
      case "click":
      case "submit":
      case "login":
      case "other":
        return this.withRetry(() => this.act(step));
      case "fill":
      case "search":
      case "select": {
        if (step.kind === "select" && !step.inputRef) return this.withRetry(() => this.act(step));
        const value = await this.resolveInput(step);
        const how = step.kind === "select" ? "select" : "fill";
        if (step.kind !== "search") return this.withRetry(() => this.fill(step, value, how));
        // A search is one execution: its fill is golden only if the submit succeeds in the same attempt.
        return this.withRetry(() =>
          this.asOneExecution(async () => {
            const field: { selector?: string } = {};
            const filled = await this.fill(step, value, how, field);
            if (filled !== "ok") return filled;
            // The planner's description is about the search box, which the model tends to return again.
            const submit = `Find the button that submits this search, not the text field the query was typed into: ${step.description}`;
            return this.act(step, submit, field.selector);
          }),
        );
      }
      case "capture_checkpoint":
        return this.withRetry(() => this.checkpoint(step));
      case "wait_for":
        return this.withRetry(() => this.waitFor(step));
    }
  }

  /** At most one retry; a planned step that still fails stops exploration. */
  private async withRetry(attempt: () => Promise<Attempt>): Promise<void> {
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      this.cacheWrites = [];
      let result: Attempt;
      try {
        result = await attempt();
      } catch (err) {
        this.cacheWrites = [];
        throw err;
      }
      if (result === "ok") {
        await this.writeCache();
        return;
      }
      if (result === "final") break;
    }
    this.cacheWrites = [];
    if (this.pageClosed()) throw new BrowserProviderError("The browser page closed during exploration");
    throw new Stop("COMPLETED");
  }

  private pageClosed(): boolean {
    try {
      return this.page.isClosed();
    } catch {
      return false;
    }
  }

  /** The value for a fill; a missing secret / test data key is never invented (BLOCKED_BY_POLICY). */
  private async resolveInput(step: PlannedStep): Promise<string> {
    const ref = step.inputRef;
    let value: string | undefined;
    let missing: BlockReason | null = null;
    if (!ref) {
      await this.reserve();
      await this.record({
        plannedStepId: step.id,
        kind: "fill",
        instruction: step.description,
        urlBefore: this.url(),
        outcome: "FAILED",
        error: `A ${step.kind} step needs an inputRef; values are never chosen by the model`,
        startedAt: this.ctx.now(),
      });
      throw new Stop("COMPLETED");
    }
    if (ref.source === "secret") {
      value = this.ctx.secrets.get(ref.key);
      if (value === undefined) missing = "MISSING_SECRET";
    } else if (ref.source === "testData") {
      const data = this.ctx.request.testData;
      if (Object.hasOwn(data, ref.key)) value = String(data[ref.key] ?? "");
      else missing = "MISSING_TEST_DATA";
    } else {
      value = ref.key;
    }
    if (missing || value === undefined) {
      await this.reserve();
      await this.record({
        plannedStepId: step.id,
        kind: "fill",
        instruction: step.description,
        inputRef: ref,
        urlBefore: this.url(),
        outcome: "BLOCKED_BY_POLICY",
        blockReason: missing ?? "MISSING_TEST_DATA",
        error: `${ref.source === "secret" ? "Secret" : "Test data key"} "${ref.key}" was not provided`,
        startedAt: this.ctx.now(),
      });
      throw new Stop("BLOCKED_BY_POLICY");
    }
    return value;
  }

  private async navigate(url: string, step: PlannedStep | null): Promise<Attempt> {
    await this.reserve();
    const startedAt = this.ctx.now();
    const urlBefore = this.url();
    const base = { plannedStepId: step?.id ?? null, kind: "navigate" as const, instruction: `Navigate to ${url}`, urlBefore, startedAt };
    try {
      await this.session.navigate(this.redactString(url));
    } catch (err) {
      this.rethrowIfFatal(err);
      if (err instanceof NavigationBlockedError) {
        await this.record({ ...base, outcome: "BLOCKED_BY_POLICY", blockReason: err.reason ?? "TARGET_BLOCKED_BY_POLICY", error: firstLine(err) });
        throw new Stop("BLOCKED_BY_POLICY");
      }
      await this.record({ ...base, outcome: "FAILED", error: firstLine(err) });
      return "failed";
    }
    await this.record({ ...base, outcome: "SUCCESS", onGoldenPath: true });
    return "ok";
  }

  /**
   * observe → policy → deterministic click (or a safe `other` method) on the observed element.
   * `searchField`: the selector a search's query was just filled into; clicking it again submits
   * nothing, so the attempt fails instead of recording a search that never ran.
   */
  private async act(step: PlannedStep, observeInstruction = step.description, searchField?: string): Promise<Attempt> {
    const located = await this.locate(step, observeInstruction);
    if (!located) return "failed";
    const instruction = observeInstruction;
    if (searchField !== undefined && located.element.selector === searchField) {
      await this.reserve();
      await this.record({
        plannedStepId: step.id,
        kind: "act",
        instruction,
        element: located.ref,
        urlBefore: this.url(),
        startedAt: this.ctx.now(),
        outcome: "FAILED",
        error: "The search's submit control resolved to the search field itself",
      });
      return "failed";
    }
    await this.enforcePolicy(step, instruction, located, "act");

    await this.reserve();
    const startedAt = this.ctx.now();
    const urlBefore = this.url();
    const base = { plannedStepId: step.id, kind: "act" as const, instruction, element: located.ref, urlBefore, startedAt };
    let result;
    try {
      result = await this.session.actOn(this.safeAction(located.element, step.kind));
    } catch (err) {
      this.rethrowIfFatal(err);
      await this.record({ ...base, outcome: "FAILED", error: firstLine(err) });
      // The click may already have been dispatched before actOn rejected: a failed report can still
      // follow a dispatched click, so a destructive step gets no retry (repeating it could delete or pay twice).
      return this.policy.allowDestructive && isDestructiveStep(step) ? "final" : "failed";
    }
    await this.settle();
    const [block] = result.navigationBlocks;
    if (block) {
      await this.record({ ...base, outcome: "BLOCKED_BY_POLICY", blockReason: block.reason, error: "Navigation blocked by policy", llm: result.llm });
      throw new Stop("BLOCKED_BY_POLICY");
    }
    if (!result.success) {
      await this.record({ ...base, outcome: "FAILED", error: `Action did not succeed: ${result.message}`, llm: result.llm });
      // Same reasoning: `success: false` can still mean the click landed and something downstream
      // failed, so a destructive step is not repeated on the strength of that report alone.
      return this.policy.allowDestructive && isDestructiveStep(step) ? "final" : "failed";
    }
    await this.record({ ...base, outcome: "SUCCESS", onGoldenPath: true, llm: result.llm });
    return "ok";
  }

  /** `field`, when given, receives the selector of the element filled. */
  private async fill(step: PlannedStep, value: string, how: "fill" | "select", field?: { selector?: string }): Promise<Attempt> {
    const located = await this.locate(step, step.description);
    if (!located) return "failed";
    if (field) field.selector = located.element.selector;
    await this.enforcePolicy(step, step.description, located, "fill");

    await this.reserve();
    const startedAt = this.ctx.now();
    const base = {
      plannedStepId: step.id,
      kind: "fill" as const,
      instruction: step.description,
      element: located.ref,
      inputRef: step.inputRef ?? null,
      urlBefore: this.url(),
      startedAt,
    };
    try {
      if (how === "fill") await this.recorder.fill(this.page, located.element.selector, value);
      else await this.recorder.select(this.page, located.element.selector, value);
    } catch (err) {
      this.rethrowIfFatal(err);
      // The recorder keeps the value out of its errors; redact once more for the run's secrets.
      const message = firstLine(err);
      // An empty value would put [REDACTED] between every character; there is nothing to redact.
      await this.record({ ...base, outcome: "FAILED", error: value === "" ? message : message.split(value).join("[REDACTED]") });
      return "failed";
    }
    await this.record({ ...base, outcome: "SUCCESS", onGoldenPath: true });
    return "ok";
  }

  private async checkpoint(step: PlannedStep): Promise<Attempt> {
    const checkpoint = step.checkpoint!;
    const requests = this.input.requirement.facts.filter((f) => f.checkpoint === checkpoint);
    const stepId = newStepId();

    let values: Record<string, FactValue> = {};
    if (requests.length > 0) {
      await this.reserve();
      const startedAt = this.ctx.now();
      const instruction = [
        "Read these values from the current page. Use null for a value that is not shown.",
        ...requests.map((r) => `- ${r.key}: ${r.description} (${r.valueType})`),
      ].join("\n");
      const schema = z.object(Object.fromEntries(requests.map((r) => [r.key, valueSchema(r.valueType)])));
      const base = { plannedStepId: step.id, kind: "extract" as const, instruction, urlBefore: this.url(), startedAt };
      try {
        const extracted = await this.session.extract(this.redactString(instruction), schema);
        values = extracted.data as Record<string, FactValue>;
        await this.record({ ...base, outcome: "SUCCESS", llm: extracted.llm });
      } catch (err) {
        this.rethrowIfFatal(err);
        await this.record({ ...base, outcome: "FAILED", error: firstLine(err) });
        return "failed";
      }
    }

    const captured: ObservedFact[] = [urlFact(this.page, { checkpoint, stepId })];
    for (const request of requests) {
      const mode = this.modeFor(request);
      let element: ElementRef | null = null;
      if (mode) element = (await this.locate(step, this.locateInstruction(request)))?.ref ?? null;
      const input: FactCaptureInput = { key: request.key, checkpoint, stepId, modelValue: values[request.key] ?? null, element, mode };
      captured.push(
        await this.recorder.captureFact(this.page, input).catch((err: unknown) => {
          this.rethrowIfFatal(err);
          return factFromReadings({ key: input.key, checkpoint, stepId, modelValue: input.modelValue, dom: null });
        }),
      );
    }

    await this.reserve();
    const startedAt = this.ctx.now();
    const urlBefore = this.url();
    const artifactIds: string[] = [];
    let png: Buffer | null = null;
    try {
      png = await this.session.screenshot();
    } catch (err) {
      this.rethrowIfFatal(err);
      await this.ctx.publish({
        type: "artifact.omitted",
        message: `Screenshot at checkpoint ${checkpoint} could not be taken`,
        payload: { type: "SCREENSHOT", reason: "The browser could not take the screenshot" },
      });
    }
    if (png) {
      const { artifactId } = await this.deps.store.saveScreenshot({ png, fileName: `${checkpoint}.png`, sensitivity: this.sensitivity });
      artifactIds.push(artifactId);
      await this.ctx.publish({
        type: "artifact.created",
        message: `Screenshot saved at checkpoint ${checkpoint}`,
        payload: { artifactId, type: "SCREENSHOT", sensitivity: this.sensitivity },
      });
    }
    await this.record({
      id: stepId,
      plannedStepId: step.id,
      kind: "checkpoint",
      instruction: `Capture checkpoint ${checkpoint}`,
      urlBefore,
      outcome: "SUCCESS",
      onGoldenPath: true,
      startedAt,
      artifactIds,
    });
    for (const fact of captured) await this.saveFact(fact);
    return "ok";
  }

  private async waitFor(step: PlannedStep): Promise<Attempt> {
    for (let poll = 0; poll < WAIT_FOR_POLLS; poll++) {
      if (await this.locate(step, step.description)) return "ok";
      if (poll < WAIT_FOR_POLLS - 1) {
        try {
          await sleep(this.deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, this.input.budget);
        } catch (err) {
          this.rethrowIfFatal(err);
        }
      }
    }
    return "final";
  }

  // -------------------------------------------------------------------------------------------
  // Building blocks
  // -------------------------------------------------------------------------------------------

  /**
   * `observe` → first element → ElementRef + accessibility facts. Recorded as an `observe` step. With the
   * cache, a verified earlier lookup replaces the `observe` (see the header).
   */
  private async locate(step: PlannedStep, instruction: string): Promise<Located | null> {
    await this.reserve();
    const startedAt = this.ctx.now();
    const base = { plannedStepId: step.id, kind: "observe" as const, instruction, urlBefore: this.url(), startedAt };
    const cacheAt = this.deps.cache ? observeCacheKey(this.url(), this.redactString(instruction)) : null;
    if (cacheAt) {
      const hit = await this.fromCache(cacheAt.key);
      if (hit) {
        await this.record({
          ...base,
          outcome: "SUCCESS",
          element: hit.ref,
          llm: { model: this.ctx.llm?.model ?? "cache", inputTokens: 0, outputTokens: 0, cacheHit: true },
        });
        return hit;
      }
    }
    let observed;
    try {
      observed = await this.session.observe(this.redactString(instruction));
    } catch (err) {
      this.rethrowIfFatal(err);
      await this.record({ ...base, outcome: "FAILED", error: firstLine(err) });
      return null;
    }
    const element = observed.elements[0];
    if (!element) {
      await this.record({ ...base, outcome: "FAILED", error: "No matching element found", llm: observed.llm });
      return null;
    }
    let ref: ElementRef;
    let info: Located["info"];
    try {
      ref = await this.recorder.record(this.page, element.selector);
      info = await this.recorder.describe(this.page, element.selector);
    } catch (err) {
      this.rethrowIfFatal(err);
      await this.record({ ...base, outcome: "FAILED", error: firstLine(err), llm: observed.llm });
      return null;
    }
    await this.record({ ...base, outcome: "SUCCESS", element: ref, llm: observed.llm });
    if (cacheAt) {
      const entry = this.ctx.redact({ selector: element.selector, description: element.description, method: element.method, element: ref }) as CachedElement;
      this.cacheWrites.push({ key: cacheAt.key, where: cacheAt.where, entry });
    }
    return { element, ref, info };
  }

  /** A cached lookup that still holds on this page, or null (a miss, a stale entry, or a failing cache). */
  private async fromCache(key: string): Promise<Located | null> {
    const cache = this.deps.cache!;
    let cached: CachedElement | null;
    try {
      cached = await cache.get(key);
    } catch {
      return null;
    }
    if (!cached) return null;
    try {
      const ref = await this.recorder.record(this.page, cached.selector);
      const chosen = (r: ElementRef) => JSON.stringify([r.candidates[r.chosenIndex], r.framePath]);
      if (chosen(ref) !== chosen(cached.element)) return null;
      const info = await this.recorder.describe(this.page, cached.selector);
      cache.touch(key).catch(() => {});
      const element: ObservedElement = { selector: cached.selector, description: cached.description, method: cached.method, arguments: [] };
      return { element, ref, info };
    } catch (err) {
      this.rethrowIfFatal(err);
      return null;
    }
  }

  /** Writes the lookups of a planned step that succeeded; a failing write is ignored. */
  private async writeCache(): Promise<void> {
    const writes = this.cacheWrites;
    this.cacheWrites = [];
    for (const w of writes) await this.deps.cache?.put(w.key, w.where, w.entry).catch(() => {});
  }

  /**
   * Checked against the observed element before acting (the element acted on is the one checked). Without
   * destructive actions allowed, a destructive element or a step the planner flagged destructive is blocked.
   * With them allowed, a destructive element is acted on only by a destructive step (flagged, or worded as
   * one), so a page cannot turn a harmless step into a destructive one.
   */
  private async enforcePolicy(step: PlannedStep, instruction: string, located: Located, kind: "act" | "fill"): Promise<void> {
    const match = assertActionAllowed(
      { instruction, elementRole: located.info.role, elementName: located.info.name, elementText: located.info.text },
      DENY_DESTRUCTIVE,
    );
    const error = this.policy.allowDestructive
      ? !match.allowed && !isDestructiveStep(step)
        ? "The element is destructive but the planned step is not"
        : null
      : !match.allowed
        ? `Matches destructive term "${match.matched}"`
        : step.destructive
          ? "The planner marked this step destructive"
          : null;
    if (error === null) return;
    await this.reserve();
    await this.record({
      plannedStepId: step.id,
      kind,
      instruction,
      element: located.ref,
      inputRef: kind === "fill" ? (step.inputRef ?? null) : null,
      urlBefore: this.url(),
      outcome: "BLOCKED_BY_POLICY",
      blockReason: "DESTRUCTIVE_ACTION_NOT_AUTHORIZED",
      error,
      startedAt: this.ctx.now(),
    });
    throw new Stop("BLOCKED_BY_POLICY");
  }

  /** What `actOn` replays: never the model's arguments, and only value-free methods. */
  private safeAction(element: ObservedElement, kind: PlannedStep["kind"]): ObservedElement {
    const method = kind === "other" && element.method && SAFE_OTHER_METHODS.has(element.method) ? element.method : "click";
    return this.ctx.redact({ selector: element.selector, description: element.description, method, arguments: [] }) as ObservedElement;
  }

  private modeFor(request: FactRequest): FactReadMode | null {
    if (request.valueType === "boolean") {
      return this.visibleFacts.has(`${request.key}@${request.checkpoint}`) ? "visible" : null;
    }
    return modeForValueType(request.valueType);
  }

  private locateInstruction(request: FactRequest): string {
    return request.valueType === "string_list"
      ? `Find the list or container whose items are: ${request.description}`
      : `Find the element that shows: ${request.description}`;
  }

  private async settle(): Promise<void> {
    await this.page.waitForLoadState("load", { timeout: LOAD_SETTLE_TIMEOUT_MS }).catch(() => {});
  }

  /** Before any operation that records a step: cancel, budget, step limit. */
  private async reserve(): Promise<void> {
    if (this.ctx.signal.aborted) throw this.ctx.signal.reason;
    if (this.input.budget.aborted) throw new Stop("EXPLORATION_BUDGET_EXHAUSTED");
    if (this.recordedCount() >= this.max) throw new Stop("STEP_LIMIT_REACHED");
  }

  /** Lets policy blocks be handled by the caller; everything else that isn't a step failure propagates. */
  private rethrowIfFatal(err: unknown): void {
    if (this.ctx.signal.aborted) throw this.ctx.signal.reason;
    if (this.input.budget.aborted) throw new Stop("EXPLORATION_BUDGET_EXHAUSTED");
    if (err instanceof Stop) throw err;
    if (err instanceof ExplorerSessionClosedError) throw new BrowserProviderError("The explorer session closed during exploration", { cause: err });
    if (isFatal(err)) throw err;
  }

  private redactString(s: string): string {
    return String(this.ctx.redact(s));
  }

  /**
   * Runs a multi-step execution (a search: fill + submit) with its steps held back, then persists
   * and publishes them in order, each exactly once, with their final golden-path flag: kept only
   * when the whole execution succeeded, otherwise every one of its steps is off the golden path.
   */
  private async asOneExecution(execution: () => Promise<Attempt>): Promise<Attempt> {
    this.held = [];
    let result: Attempt = "failed";
    try {
      result = await execution();
      return result;
    } finally {
      const held = this.held;
      this.held = null;
      for (const step of held) await this.commit(result === "ok" ? step : { ...step, onGoldenPath: false });
    }
  }

  private async record(draft: StepDraft): Promise<ExplorationStep> {
    const step = this.build(draft);
    if (this.held) {
      this.held.push(step);
      return step;
    }
    await this.commit(step);
    return step;
  }

  private build(draft: StepDraft): ExplorationStep {
    const finishedAt = this.ctx.now();
    // Redact first, then truncate: truncating first could cut a secret so the redactor misses it.
    const redacted = this.ctx.redact({
      id: draft.id ?? newStepId(),
      runId: this.ctx.runId,
      index: this.recordedCount(),
      plannedStepId: draft.plannedStepId,
      kind: draft.kind,
      instruction: draft.instruction,
      element: draft.element ?? null,
      inputRef: draft.inputRef ?? null,
      onGoldenPath: draft.onGoldenPath ?? false,
      urlBefore: draft.urlBefore,
      urlAfter: this.url(),
      outcome: draft.outcome,
      blockReason: draft.blockReason ?? null,
      error: draft.error ?? null,
      startedAt: draft.startedAt.toISOString(),
      durationMs: Math.max(0, finishedAt.getTime() - draft.startedAt.getTime()),
      artifactIds: draft.artifactIds ?? [],
      llm: draft.llm ?? null,
    }) as ExplorationStep;
    return ExplorationStepSchema.parse({
      ...redacted,
      instruction: redacted.instruction.slice(0, 1000),
      error: redacted.error === null ? null : redacted.error.slice(0, 2000),
    });
  }

  /** Persists and publishes a step (once, never updated afterwards). */
  private async commit(step: ExplorationStep): Promise<void> {
    await this.deps.store.saveStep(step);
    this.steps.push(step);
    await this.ctx.publish({
      type: "step.recorded",
      message: `Step ${step.index + 1}: ${step.kind} ${OUTCOME_LABEL[step.outcome]}`,
      payload: { stepId: step.id, index: step.index, kind: step.kind, outcome: step.outcome, blockReason: step.blockReason },
    });
  }

  /** Recorded steps, including those held back by `asOneExecution`. */
  private recordedCount(): number {
    return this.steps.length + (this.held?.length ?? 0);
  }

  private async saveFact(fact: ObservedFact): Promise<void> {
    const safe = ObservedFactSchema.parse(this.ctx.redact(fact));
    await this.deps.store.saveFact(safe);
    this.facts.push(safe);
    await this.ctx.publish({
      type: "fact.observed",
      message: `Fact ${safe.key} captured at ${safe.checkpoint} (${safe.provenance === "DOM_VERIFIED" ? "read from the page" : "model-extracted"})`,
      payload: { key: safe.key, checkpoint: safe.checkpoint, provenance: safe.provenance },
    });
  }
}

/** Runs the plan's scenario and records steps and facts. Always closes the session. */
export async function runExploration(ctx: StageContext, input: ExplorationInput, deps: ExplorationDeps): Promise<ExplorationOutcome> {
  try {
    return await new ExplorationRun(ctx, input, deps).execute();
  } finally {
    await input.session.close().catch(() => {});
  }
}
