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
import { createInputGenerator, type FieldFacts, type InputGenerator } from "./input-generator";
import { describeElement, describeField, elementAction, fieldValue, fillElement, recordElement, selectElementOption } from "./recorder";

/**
 * Exploration executor (Task 14): runs the confirmed plan's scenarios (V1.1 F9: in order, each from a clean
 * session; see `execute`) through an `ExplorerSession` and records replayable `ExplorationStep`s and
 * `ObservedFact`s.
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
 *                view). Recorded: `observe` + `act`. An element that cannot be clicked (a status, a heading, …)
 *                gets one more lookup for the link or button itself. Nothing to click on the page: the explorer is asked once for
 *                the link or button that leads there, which is clicked (policy-checked) before looking again.
 * - fill         Value from `inputRef` (testData / secret via `ctx.secrets.get` / literal) →
 *                `observe(description)` → policy check → the recorder's deterministic `fill`. An observed link
 *                (the way to the field) is clicked once (policy-checked, recorded `act`) and the field observed
 *                again there; a second link fails the attempt. A secret the model finds no field for goes into
 *                the page's only visible password field (recorded `observe`, no model call), if there is exactly one.
 *                No field at all: the explorer is asked once for the link or button that opens the form, which is
 *                clicked (policy-checked) before the field is looked for again.
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
 *                comes first. A located element with nothing to read (no number, empty text) gets one more
 *                lookup for the element that shows the value itself. A value the model read as null where its located element shows one is
 *                extracted once more, alone (the DOM reading must still equal the answer). Then a
 *                screenshot artifact. Recorded: `extract`, `observe`s, and the
 *                `checkpoint` step the facts point at (`stepId`, `artifactIds`).
 * - wait_for     Bounded poll: up to 3 `observe`s, `pollIntervalMs` apart, within the budget. An element that
 *                never appears does not stop exploration (KI-001: models plan waits for a page "to load", which
 *                names no element): the failed observes are recorded, and the checkpoint facts and later steps
 *                decide. It is the only planned step that does not stop exploration when it fails.
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
 * `observe` with `llm.cacheHit: true` and no tokens, and only while the element still does what it did then (its
 * tag, type, link target and form action; KI-032). A share of hits (`cacheRecheckRate`) asks the explorer again,
 * and the fresh lookup replaces the entry. The action policy checks the element either way. A new
 * lookup is written only once the planned step that used it succeeded, so a failed, blocked or retried
 * attempt never populates the cache. A failing cache is a miss.
 */

/** The default share of exploration cache hits looked up again (KI-032). */
const CACHE_RECHECK_RATE = 0.1;

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
  /** What the element does (elementAction); used to check a cached lookup (KI-032). Absent: never checked. */
  action?(page: Page, selector: string): Promise<string>;
  fill(page: Page, selector: string, value: string): Promise<void>;
  select(page: Page, selector: string, value: string): Promise<void>;
  captureFact(page: Page, input: FactCaptureInput): Promise<ObservedFact>;
  /** What a field asks for, for a value nobody provided (2026-10-07). Absent: the generator sees only the step. */
  describeField?(page: Page, selector: string): Promise<FieldFacts>;
  /** What a filled field holds now, null when it cannot be read (fieldValue). Absent: typed values are never re-checked. */
  value?(page: Page, selector: string): Promise<string | null>;
}

export const playwrightRecorder: RecorderPort = {
  async describe(page, selector) {
    const d = await describeElement(page, selector);
    return { role: d.role, name: d.name, text: d.text };
  },
  record: (page, selector) => recordElement(page, selector),
  action: (page, selector) => elementAction(page, selector),
  fill: (page, selector, value) => fillElement(page, selector, value),
  select: (page, selector, value) => selectElementOption(page, selector, value),
  captureFact: (page, input) => captureFact(page, input),
  describeField: (page, selector) => describeField(page, selector),
  value: (page, selector) => fieldValue(page, selector),
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
  /** Makes the values nobody provided (2026-10-07); default `createInputGenerator(ctx.llm)`. */
  inputs?: InputGenerator;
  /** Delay between `wait_for` polls. */
  pollIntervalMs?: number;
  /** Cached element lookups from earlier runs (V1.1 F8); absent: every lookup asks the explorer. */
  cache?: ObserveCache;
  /**
   * The share of cache hits looked up again with `observe` anyway, the fresh lookup replacing the entry once its
   * step succeeds (KI-032): an entry the page or a steered model made wrong does not live for its whole 30 days.
   * Default 0.1; `random` is the test seam.
   */
  cacheRecheckRate?: number;
  random?: () => number;
  /**
   * Starts the next scenario from a clean session (V1.1 F9): cookies and the target origin's storage
   * cleared. Default: the Playwright/CDP implementation (clearBrowserState).
   */
  resetSession?: (page: Page, targetUrl: string) => Promise<void>;
}

/**
 * The default session reset between scenarios: every cookie, and the target origin's storage (local and
 * session storage, IndexedDB, cache storage, service workers) through CDP. The next scenario's first step
 * then loads the target in a fresh document.
 */
export async function clearBrowserState(page: Page, targetUrl: string): Promise<void> {
  await page.context().clearCookies();
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Storage.clearDataForOrigin", { origin: new URL(targetUrl).origin, storageTypes: "all" });
  } finally {
    await cdp.detach().catch(() => {});
  }
}

const MAX_ATTEMPTS = 2; // one retry per planned step
const WAIT_FOR_POLLS = 3;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
/** Roles of elements a click step never targets: they show something, they do nothing when clicked (KI-001). */
const NOT_CLICKABLE = new Set(["status", "heading", "paragraph", "img", "list", "listitem", "note", "alert", "log", "marquee", "timer", "article", "region", "banner", "contentinfo", "main"]);
/** A secret fill's fallback when the model finds no field: the page's only visible password field. */
const PASSWORD_FIELD = 'input[type="password"] >> visible=true';
/**
 * How a list fact reads a message shown in place of its list (KI-001): as the list's only item, as the fact
 * reader reads that message's element (`text_list`), so an empty cart is evidence a "contains" check can FAIL on.
 */
const LIST_IN_PLACE_RULE =
  "For a list (string_list): when the page shows a message in place of the list (e.g. that it is empty), give that message as its only item; null only when neither the list nor such a message is shown.";
const LOAD_SETTLE_TIMEOUT_MS = 10_000;
/**
 * How long a navigation waits, after `load`, for the network to go quiet (2026-10-07): a page that renders its form
 * from scripts still loading can empty a field typed into before then (demoqa's register page empties its first
 * field 1-2.5 s after `load`). A page that never goes quiet (polling, ads) costs this much and is not an error.
 */
const NETWORK_QUIET_TIMEOUT_MS = 3_000;
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
  /** A fill's value that nobody provided (2026-10-07). */
  generatedValue?: string;
}

/** What the generator is told about a field the recorder cannot describe. */
const NO_FIELD_FACTS: FieldFacts = { tag: "input", type: null, name: null, label: null, placeholder: null, autocomplete: null, maxLength: null, min: null, max: null, pattern: null, options: [] };

interface Located {
  element: ObservedElement;
  ref: ElementRef;
  info: { role: string | null; name: string | null; text: string | null };
}

/** A value our recorder typed since the last click or navigation, re-checked before the next click. */
interface Typed {
  step: PlannedStep;
  located: Located;
  value: string;
  generatedValue?: string;
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
  /** The scenario being explored (V1.1 F9); recorded on each step when the plan has several. */
  private scenarioId = "SC-1";
  private readonly multiScenario: boolean;
  /** New lookups of the planned step in progress, written to the cache only if it succeeds. */
  private cacheWrites: { key: string; where: CacheWhere; entry: CachedElement }[] = [];
  private readonly session: ExplorerSession;
  private readonly recorder: RecorderPort;
  private readonly policy: ActionPolicy;
  /** Screenshots are never secret-bearing: a run's secrets are no longer redacted (2026-10-07). */
  private readonly sensitivity: ArtifactSensitivity = "STANDARD";
  private readonly max: number;
  private readonly visibleFacts: Set<string>;
  private readonly inputs: InputGenerator;
  /** Values generated for this run, by `source:key`: made once, reused by every later fill of the key. */
  private readonly generated = new Map<string, string>();
  /** Values typed since the last click or navigation (2026-10-07). */
  private typed: Typed[] = [];

  constructor(
    private readonly ctx: StageContext,
    private readonly input: ExplorationInput,
    private readonly deps: ExplorationDeps,
  ) {
    const { request } = ctx;
    this.session = input.session;
    this.recorder = deps.recorder ?? playwrightRecorder;
    this.inputs = deps.inputs ?? createInputGenerator(ctx.llm);
    this.policy = actionPolicyFor(request);
    this.max = request.options.maxExplorationSteps;
    this.multiScenario = input.plan.scenarios.length > 1;
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

  /**
   * The plan's scenarios in order (V1.1 F9). A failed or blocked step ends its own scenario; the step
   * limit and the budget end exploration (later scenarios get the same stop reason, unexplored). Every
   * scenario after the first starts from a clean session. `stopReason` is the first scenario's that did not
   * complete (COMPLETED when all did); `scenarioStops` gives each one's, when there are several.
   */
  async execute(): Promise<ExplorationOutcome> {
    const scenarios = this.input.plan.scenarios;
    const stops: Record<string, ExplorationStopReason> = {};
    let exhausted: ExplorationStopReason | null = null;
    for (const [i, scenario] of scenarios.entries()) {
      this.scenarioId = scenario.id;
      if (exhausted) {
        stops[scenario.id] = exhausted;
        continue;
      }
      try {
        if (i > 0) await this.resetSession();
        await this.exploreScenario(scenario.steps);
        stops[scenario.id] = "COMPLETED";
      } catch (err) {
        if (!(err instanceof Stop)) {
          if (this.ctx.signal.aborted) throw this.ctx.signal.reason;
          throw err;
        }
        stops[scenario.id] = err.reason;
        if (err.reason === "STEP_LIMIT_REACHED" || err.reason === "EXPLORATION_BUDGET_EXHAUSTED") exhausted = err.reason;
      }
    }
    const stopReason = scenarios.map((s) => stops[s.id]!).find((r) => r !== "COMPLETED") ?? "COMPLETED";
    return { steps: [...this.steps], facts: [...this.facts], stopReason, ...(this.multiScenario ? { scenarioStops: stops } : {}) };
  }

  /** One scenario: its first action opens the target URL (see the header), then its planned steps. */
  private async exploreScenario(planned: readonly PlannedStep[]): Promise<void> {
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
  }

  /** Clears the browser session before a scenario; a failure is the browser's (the run errs, never guesses). */
  private async resetSession(): Promise<void> {
    await this.ctx.boundary();
    try {
      await (this.deps.resetSession ?? clearBrowserState)(this.page, this.ctx.request.targetUrl);
    } catch (err) {
      this.rethrowIfFatal(err);
      throw new BrowserProviderError("The browser session could not be cleared between scenarios", { cause: err });
    }
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
        await this.waitFor(step);
        return;
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
  /**
   * The value a fill types: the run's test data or secret, or the requirement's literal. Null when nobody provided it
   * (2026-10-07): the fill then generates one from the field it located (`generatedInput`), so nothing is blocked.
   */
  private async resolveInput(step: PlannedStep): Promise<string | null> {
    const ref = step.inputRef;
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
    if (ref.source === "secret") return this.ctx.secrets.get(ref.key) ?? null;
    if (ref.source === "testData") {
      const data = this.ctx.request.testData;
      return Object.hasOwn(data, ref.key) ? String(data[ref.key] ?? "") : null;
    }
    return ref.key;
  }

  /** A value nobody provided, for the located field: one generator call per `source:key` in the run, reused after. */
  private async generatedInput(step: PlannedStep, located: Located): Promise<{ value: string; llm: LlmStepUsage | null }> {
    const ref = step.inputRef!;
    const source = ref.source === "secret" ? "secret" : "testData";
    const id = `${source}:${ref.key}`;
    const known = this.generated.get(id);
    if (known !== undefined) return { value: known, llm: null };
    const field = (await this.recorder.describeField?.(this.page, located.element.selector).catch(() => null)) ?? NO_FIELD_FACTS;
    const out = await this.inputs.generate({
      source,
      key: ref.key,
      stepDescription: step.description,
      field,
      runId: this.ctx.runId,
      signal: this.input.budget,
      deadlineAt: this.ctx.deadlineAt,
      redact: this.ctx.redact,
    });
    this.generated.set(id, out.value);
    return out;
  }

  private async navigate(url: string, step: PlannedStep | null): Promise<Attempt> {
    await this.reserve();
    const startedAt = this.ctx.now();
    const urlBefore = this.url();
    const base = { plannedStepId: step?.id ?? null, kind: "navigate" as const, instruction: `Navigate to ${url}`, urlBefore, startedAt };
    this.typed = [];
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
    await this.page.waitForLoadState("networkidle", { timeout: NETWORK_QUIET_TIMEOUT_MS }).catch(() => {});
    await this.record({ ...base, outcome: "SUCCESS", onGoldenPath: true });
    return "ok";
  }

  /**
   * observe → policy → deterministic click (or a safe `other` method) on the observed element.
   * `searchField`: the selector a search's query was just filled into; clicking it again submits
   * nothing, so the attempt fails instead of recording a search that never ran.
   */
  private async act(step: PlannedStep, observeInstruction = step.description, searchField?: string): Promise<Attempt> {
    let located = await this.locate(step, observeInstruction);
    // Nothing to click on this page (e.g. a product link after the login opened the account page, KI-001): ask once
    // for the way there, follow it (policy-checked) and look again. Not for a search's submit control.
    if (!located && searchField === undefined && observeInstruction === step.description) {
      const instruction = `Find the link or button that leads to where you can: ${step.description}`;
      const way = await this.locate(step, instruction);
      if (!way) return "failed";
      const followed = await this.click(step, instruction, way);
      if (followed !== "ok") return followed;
      located = await this.locate(step, observeInstruction);
    }
    if (!located) return "failed";
    // An element that cannot be clicked (e.g. the "Cart (1)" status badge for "Open the cart page", KI-001): ask once
    // for the link or button itself.
    if (located.info.role !== null && NOT_CLICKABLE.has(located.info.role)) {
      const target = await this.locate(step, `Find the link or button to click, not text, a heading or a status: ${step.description}`);
      if (!target || (target.info.role !== null && NOT_CLICKABLE.has(target.info.role))) return "failed";
      located = target;
    }
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
    return this.click(step, instruction, located);
  }

  /** Clicks a located element: the action policy first, then the explorer; recorded as an `act` step. */
  private async click(step: PlannedStep, instruction: string, located: Located): Promise<Attempt> {
    await this.enforcePolicy(step, instruction, located, "act");
    await this.retypeCleared();
    // The click may change or replace the form: what was typed before it is not checked again.
    this.typed = [];

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
  private async fill(step: PlannedStep, provided: string | null, how: "fill" | "select", field?: { selector?: string }): Promise<Attempt> {
    let located = await this.findField(step);
    // No field on this page (e.g. credentials planned on the start page, KI-001): ask once for the way to its form.
    if (!located) {
      const opened = await this.openForm(step);
      if (typeof opened === "string") return opened;
      located = opened;
    }
    if (!located) return "failed";
    // A button is never the field (the explorer returned a search's Search button for its query, KI-001): ask once
    // for the text field itself.
    if (located.info.role === "button") {
      const field = await this.locate(step, `Find the text field to type into, not a button or link: ${step.description}`);
      if (!field || field.info.role === "button" || field.info.role === "link") return "failed";
      located = field;
    }
    // A link is the way to the field (e.g. "Search the catalog" on a page without a search box points at the
    // Products link, KI-001): follow it once, then look for the field on that page. Never type into a link.
    if (located.info.role === "link") {
      const followed = await this.click(step, step.description, located);
      if (followed !== "ok") return followed;
      located = await this.locate(step, step.description);
      if (!located) return "failed";
      if (located.info.role === "link") {
        await this.reserve();
        await this.record({
          plannedStepId: step.id,
          kind: "fill",
          instruction: step.description,
          element: located.ref,
          inputRef: step.inputRef ?? null,
          urlBefore: this.url(),
          startedAt: this.ctx.now(),
          outcome: "FAILED",
          error: "The field resolved to a link again after following one",
        });
        return "failed";
      }
    }
    if (field) field.selector = located.element.selector;
    await this.enforcePolicy(step, step.description, located, "fill");
    const generated = provided === null ? await this.generatedInput(step, located) : null;
    const value = provided ?? generated!.value;

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
      ...(generated ? { generatedValue: generated.value, llm: generated.llm } : {}),
    };
    try {
      if (how === "fill") await this.recorder.fill(this.page, located.element.selector, value);
      else await this.recorder.select(this.page, located.element.selector, value);
    } catch (err) {
      this.rethrowIfFatal(err);
      await this.record({ ...base, outcome: "FAILED", error: firstLine(err) });
      return "failed";
    }
    await this.record({ ...base, outcome: "SUCCESS", onGoldenPath: true });
    if (how === "fill") this.typed.push({ step, located, value, ...(generated ? { generatedValue: generated.value } : {}) });
    return "ok";
  }

  /**
   * Types again, before a click, a value the page emptied after our recorder typed it (2026-10-07): a page still
   * starting up can reset its form (KI-044), and the click would then submit it without the value. Only a field now
   * empty is typed again; one the page reformatted, one gone from the page and a selection are left alone. Recorded
   * as a golden fill of the same planned step, so the generated test types it again at the same point.
   */
  private async retypeCleared(): Promise<void> {
    if (!this.recorder.value) return;
    for (const typed of this.typed) {
      if (typed.value === "") continue;
      const now = await this.recorder.value(this.page, typed.located.element.selector).catch(() => null);
      if (now !== "") continue;
      await this.reserve();
      const base = {
        plannedStepId: typed.step.id,
        kind: "fill" as const,
        instruction: `Fill again, the page cleared it: ${typed.step.description}`,
        element: typed.located.ref,
        inputRef: typed.step.inputRef ?? null,
        urlBefore: this.url(),
        startedAt: this.ctx.now(),
        ...(typed.generatedValue !== undefined ? { generatedValue: typed.generatedValue } : {}),
      };
      try {
        await this.recorder.fill(this.page, typed.located.element.selector, typed.value);
      } catch (err) {
        this.rethrowIfFatal(err);
        await this.record({ ...base, outcome: "FAILED", error: firstLine(err) });
        continue;
      }
      await this.record({ ...base, outcome: "SUCCESS", onGoldenPath: true });
    }
  }

  /** The fill's field: the explorer's answer, else, for a secret, the page's only visible password field (KI-001). */
  private async findField(step: PlannedStep): Promise<Located | null> {
    const located = await this.locate(step, step.description);
    if (located || step.inputRef?.source !== "secret") return located;
    return this.onlyPasswordField(step);
  }

  /**
   * When a fill finds no field on the page: the link or button that opens its page or form, clicked (policy-checked,
   * a recorded act), then the field looked for there. Once per attempt; null when nothing opens it or the field is
   * still missing, an Attempt when the click itself did not succeed.
   */
  private async openForm(step: PlannedStep): Promise<Located | null | Exclude<Attempt, "ok">> {
    const instruction = `Find the link or button that opens the page or form with the field for: ${step.description}`;
    const way = await this.locate(step, instruction);
    if (!way) return null;
    const clicked = await this.click(step, instruction, way);
    if (clicked !== "ok") return clicked;
    return this.findField(step);
  }

  /**
   * The page's only visible password field, located deterministically and recorded as an `observe` without a model
   * call; null when there is not exactly one. Only for a fill that types a secret: our recorder still types it, and
   * the action policy still checks the field.
   */
  private async onlyPasswordField(step: PlannedStep): Promise<Located | null> {
    let ref: ElementRef;
    let info: Located["info"];
    try {
      ref = await this.recorder.record(this.page, PASSWORD_FIELD);
      info = await this.recorder.describe(this.page, PASSWORD_FIELD);
    } catch (err) {
      this.rethrowIfFatal(err);
      return null;
    }
    await this.reserve();
    await this.record({
      plannedStepId: step.id,
      kind: "observe",
      instruction: `${step.description} (the page's only password field)`,
      urlBefore: this.url(),
      startedAt: this.ctx.now(),
      outcome: "SUCCESS",
      element: ref,
      llm: null,
    });
    return { element: { selector: PASSWORD_FIELD, description: "the page's only password field", method: "fill", arguments: [] }, ref, info };
  }

  private async checkpoint(step: PlannedStep): Promise<Attempt> {
    const checkpoint = step.checkpoint!;
    const requests = this.input.requirement.facts.filter((f) => f.checkpoint === checkpoint);
    const stepId = newStepId();

    let values: Record<string, FactValue> = {};
    if (requests.length > 0) {
      const extracted = await this.extract(step, requests);
      if (!extracted) return "failed";
      values = extracted;
    }

    const captured: ObservedFact[] = [urlFact(this.page, { checkpoint, stepId })];
    for (const request of requests) {
      const mode = this.modeFor(request);
      let element: ElementRef | null = null;
      if (mode) {
        element = (await this.locate(step, this.locateInstruction(request)))?.ref ?? null;
        // A list's container not found: once more, as the element that shows it (KI-001).
        if (!element && request.valueType === "string_list") element = (await this.locate(step, `Find the element that shows: ${request.description}`))?.ref ?? null;
      }
      const capture = (modelValue: FactValue) =>
        this.recorder.captureFact(this.page, { key: request.key, checkpoint, stepId, modelValue, element, mode }).catch((err: unknown) => {
          this.rethrowIfFatal(err);
          return factFromReadings({ key: request.key, checkpoint, stepId, modelValue, dom: null });
        });
      let fact = await capture(values[request.key] ?? null);
      // The located element has nothing to read (e.g. the Cart link for "number in the cart badge", KI-001): look once
      // more for the element that shows the value itself; the reading must still equal the model's (D2).
      if (mode && fact.provenance === "MODEL_EXTRACTED" && fact.modelValue !== null && fact.read && (fact.domValue === null || fact.domValue === "")) {
        const own = await this.locate(step, `Find the element whose own text shows it, not a link or button that leads to it: ${request.description}`);
        if (own) {
          element = own.ref;
          fact = await capture(values[request.key] ?? null);
        }
      }
      // The model said "not shown" where the element it located shows a value (KI-001): ask for that value once more,
      // alone; the DOM reading must still equal the answer (D2).
      if (fact.provenance === "MODEL_EXTRACTED" && fact.modelValue === null && fact.domValue !== undefined && fact.domValue !== null) {
        const again = await this.extract(step, [request]);
        if (again && again[request.key] !== null && again[request.key] !== undefined) fact = await capture(again[request.key]!);
      }
      captured.push(fact);
    }

    await this.reserve();
    const startedAt = this.ctx.now();
    const urlBefore = this.url();
    const artifactIds = await this.screenshot(`${checkpoint}.png`, `at checkpoint ${checkpoint}`);
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

  /** One `extract` of these facts' model values, recorded; null when it failed (recorded FAILED). */
  private async extract(step: PlannedStep, requests: readonly FactRequest[]): Promise<Record<string, FactValue> | null> {
    await this.reserve();
    const startedAt = this.ctx.now();
    const instruction = [
      "Read these values from the current page: the text the page shows, never element ids. Use null for a value that is not shown.",
      ...(requests.some((r) => r.valueType === "string_list") ? [LIST_IN_PLACE_RULE] : []),
      ...requests.map((r) => `- ${r.key}: ${r.description} (${r.valueType})`),
    ].join("\n");
    const schema = z.object(Object.fromEntries(requests.map((r) => [r.key, valueSchema(r.valueType)])));
    const base = { plannedStepId: step.id, kind: "extract" as const, instruction, urlBefore: this.url(), startedAt };
    try {
      const extracted = await this.session.extract(this.redactString(instruction), schema);
      await this.record({ ...base, outcome: "SUCCESS", llm: extracted.llm });
      return extracted.data as Record<string, FactValue>;
    } catch (err) {
      this.rethrowIfFatal(err);
      await this.record({ ...base, outcome: "FAILED", error: firstLine(err) });
      return null;
    }
  }

  /** Polls for the step's element; whether it appeared or not, exploration goes on (see the header). */
  private async waitFor(step: PlannedStep): Promise<void> {
    this.cacheWrites = [];
    for (let poll = 0; poll < WAIT_FOR_POLLS; poll++) {
      if (await this.locate(step, step.description)) return this.writeCache();
      if (poll < WAIT_FOR_POLLS - 1) {
        try {
          await sleep(this.deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, this.input.budget);
        } catch (err) {
          this.rethrowIfFatal(err);
        }
      }
    }
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
      const recheck = (this.deps.random ?? Math.random)() < (this.deps.cacheRecheckRate ?? CACHE_RECHECK_RATE);
      const hit = recheck ? null : await this.fromCache(cacheAt.key);
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
    let action: string | undefined;
    try {
      ref = await this.recorder.record(this.page, element.selector);
      info = await this.recorder.describe(this.page, element.selector);
      if (cacheAt) action = await this.recorder.action?.(this.page, element.selector);
    } catch (err) {
      this.rethrowIfFatal(err);
      await this.record({ ...base, outcome: "FAILED", error: firstLine(err), llm: observed.llm });
      return null;
    }
    await this.record({ ...base, outcome: "SUCCESS", element: ref, llm: observed.llm });
    if (cacheAt) {
      const entry = this.ctx.redact({ selector: element.selector, description: element.description, method: element.method, element: ref, action }) as CachedElement;
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
      // Same locator, but does it still do the same thing? An entry from before KI-032 has no action: a miss.
      if (this.recorder.action) {
        if (cached.action === undefined) return null;
        if (this.ctx.redact(await this.recorder.action(this.page, cached.selector)) !== cached.action) return null;
      }
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
      ? `Find the list or container whose items are: ${request.description} (or the message shown in its place, e.g. that it is empty)`
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

  /**
   * A full-page screenshot of the current page (V1.3; the viewport when the full page cannot be taken), stored
   * and announced; [] with `artifact.omitted` when neither can be taken. Cancel, the budget and infrastructure
   * errors propagate.
   */
  private async screenshot(fileName: string, where: string): Promise<string[]> {
    let png: Buffer | null = null;
    for (const fullPage of [true, false]) {
      try {
        png = await this.session.screenshot({ fullPage });
        break;
      } catch (err) {
        this.rethrowIfFatal(err);
      }
    }
    if (!png) {
      await this.ctx.publish({
        type: "artifact.omitted",
        message: `Screenshot ${where} could not be taken`,
        payload: { type: "SCREENSHOT", reason: "The browser could not take the screenshot" },
      });
      return [];
    }
    const { artifactId } = await this.deps.store.saveScreenshot({ png, fileName, sensitivity: this.sensitivity });
    await this.ctx.publish({
      type: "artifact.created",
      message: `Screenshot saved ${where}`,
      payload: { artifactId, type: "SCREENSHOT", sensitivity: this.sensitivity },
    });
    return [artifactId];
  }

  private async record(draft: StepDraft): Promise<ExplorationStep> {
    // A step blocked by policy keeps what the page showed when it was stopped (V1.3): the blocked criteria's
    // evidence. Never for a stop caused by the budget or a cancel (those throw before a step is recorded).
    if (draft.outcome === "BLOCKED_BY_POLICY" && !draft.artifactIds?.length) {
      draft = { ...draft, artifactIds: await this.screenshot(`blocked-step-${this.recordedCount() + 1}.png`, "where exploration was blocked") };
    }
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
      ...(this.multiScenario ? { scenarioId: this.scenarioId } : {}),
      ...(draft.generatedValue !== undefined ? { generatedValue: draft.generatedValue } : {}),
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
