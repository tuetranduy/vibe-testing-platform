import { randomBytes } from "node:crypto";
import {
  BrowserProviderError,
  CancelledError,
  EngineError,
  ExplorationStepSchema,
  ObservedFactSchema,
  keyWords,
  scenarioOfCriterion,
  type ArtifactSensitivity,
  type BlockReason,
  type AcceptanceCriterion,
  type CachedElement,
  type CriterionJudgment,
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
  type TestScenario,
} from "@platform/contracts";
import { assertActionAllowed, type ActionPolicy } from "@platform/security";
import {
  ExplorerSessionClosedError,
  ExplorerTransientError,
  NavigationBlockedError,
  type ExplorerSession,
  type LlmStepUsage,
  type ObservedElement,
} from "@platform/stagehand-adapter/browser-explorer";
import type { Page, Request as PwRequest } from "playwright-core";
import { z } from "zod";
import type { StageContext } from "../orchestrator/stages";
import { actionPolicyFor, isDestructiveStep } from "../shared/action-policy";
import { captureFact, factFromReadings, modeForValueType, urlFact, type FactCaptureInput, type FactReadMode } from "./fact-reader";
import { isAllowedPageHost } from "../survey/links";
import { factValuesEqual } from "../shared/fact-values";
import { observeCacheKey, type CacheWhere, type ObserveCache } from "./observe-cache";
import { INVENTORY_SCRIPT, parseRawInventory, toPageInventory, type PageInventory } from "../survey/inventory";
import { createInputGenerator, type FieldFacts, type InputGenerator } from "./input-generator";
import { JUDGE_TEXT_MAX_CHARS, createCriterionJudge, type CriterionJudge } from "./judge";
import {
  checkElement,
  describeElement,
  describeField,
  elementAction,
  fieldValue,
  fillElement,
  hittableAlternative,
  isHittable,
  reachableNamedControl,
  recordElement,
  requiredEmptyFields,
  selectElementOption,
  type RequiredField,
} from "./recorder";
import { captureEarlyNotificationFact, notificationTexts } from "./early-facts";
import { captureNamedFact } from "./named-facts";

/**
 * Exploration executor (Task 14): runs the confirmed plan's scenarios (V1.1 F9: in order, each from a clean
 * session; see `execute`) through an `ExplorerSession` and records replayable `ExplorationStep`s and
 * `ObservedFact`s.
 *
 * Planned step kind → what runs (and what is recorded):
 *
 * - (start)      The first action navigates to `request.targetUrl` (`session.navigate`, kind
 *                `navigate`). If the first planned step explicitly opens the target URL or generically
 *                opens the site, this navigation *is* that step; a named page must still be visited.
 *                Otherwise the initial navigation is recorded with
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
 *                First read explicitly named fields and visibility subjects directly from the DOM (including
 *                replayable absence predicates); ambiguous subjects fall back. One `extract` of remaining
 *                FactRequests at that checkpoint (model values) → for each remaining fact
 *                with a DOM read mode, `observe` its element → recorder `captureFact` (DOM_VERIFIED
 *                when the DOM agrees, else MODEL_EXTRACTED). Read mode = `modeForValueType`, except
 *                a boolean is read as `visible` only when a `visible` outcome references that
 *                (key, checkpoint), else it has no DOM read (Ruling R24). The reserved `url` fact
 *                comes first. A located element with nothing to read (no number, empty text) gets one more
 *                lookup for the element that shows the value itself. A value the model read differently from its located
 *                element, where that element shows one (null, or read before the page finished loading, KI-071), is
 *                extracted once more, alone, once the network is quiet (the DOM reading must still equal the answer). Then a
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

/** A number fact that counts listed items: "Number of products listed", "how many search results", "count of items". */
const ITEM_COUNT = /\b(?:number|count|how many|total)\b[^.]{0,60}\b(?:products?|results?|items?|entries|rows|cards|articles|listings?)\b/i;

/** Whether a DOM reading shows something: not absent, null, empty text or an empty list. */
const shows = (value: FactValue | undefined): boolean =>
  value !== undefined && value !== null && value !== "" && !(Array.isArray(value) && value.length === 0);

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
  pointerAction?(page: Page, selector: string, method: "scroll_into_view" | "hover" | "double_click"): Promise<void>;
  /** Named controls read directly from the DOM, including replayable absence checks. */
  captureNamedFact?(page: Page, request: FactRequest, mode: FactReadMode, stepId: string): Promise<ObservedFact | null>;
  describe(page: Page, selector: string): Promise<{ role: string | null; name: string | null; text: string | null }>;
  record(page: Page, selector: string): Promise<ElementRef>;
  /** What the element does (elementAction); used to check a cached lookup (KI-032). Absent: never checked. */
  action?(page: Page, selector: string): Promise<string>;
  fill(page: Page, selector: string, value: string): Promise<void>;
  select(page: Page, selector: string, value: string): Promise<void>;
  captureFact(page: Page, input: FactCaptureInput): Promise<ObservedFact>;
  /** `before`: the notifications shown before the action (notificationTexts), when they were read (KI-059). */
  captureEarlyFact?(page: Page, request: FactRequest, criteria: readonly AcceptanceCriterion[], stepId: string, before?: readonly string[] | null): Promise<ObservedFact | null>;
  /** The texts of the notifications the page shows now, read before an action whose checkpoint may need them. */
  notificationTexts?(page: Page): Promise<string[]>;
  /** What a field asks for, for a value nobody provided (2026-10-07). Absent: the generator sees only the step. */
  describeField?(page: Page, selector: string): Promise<FieldFacts>;
  /** What a filled field holds now, null when it cannot be read (fieldValue). Absent: typed values are never re-checked. */
  value?(page: Page, selector: string): Promise<string | null>;
  /**
   * The required fields still empty in the form a click submits, and whether the run typed into that form
   * (requiredEmptyFields, KI-062). Absent: a form is submitted as the plan left it.
   */
  requiredEmptyFields?(page: Page, submitSelector: string, typedSelectors: readonly string[]): Promise<{ touched: boolean; fields: RequiredField[] }>;
  /** Checks a checkbox or radio (checkElement, KI-062). */
  check?(page: Page, selector: string): Promise<void>;
  /** Whether a click would land on the element (isHittable, R2). Absent: every element is taken as reachable. */
  hittable?(page: Page, selector: string): Promise<boolean>;
  /** A reachable element the ref's role / test id / label / text candidates match (hittableAlternative, R2). */
  hittableAlternative?(page: Page, ref: ElementRef): Promise<string | null>;
  /** The first reachable element of these roles whose accessible name contains the name (reachableNamedControl, KI-072). */
  namedControl?(page: Page, name: string, roles: readonly string[]): Promise<string | null>;
}

export const playwrightRecorder: RecorderPort = {
  async pointerAction(page, selector, method) {
    const locator = page.locator(selector);
    if (method === 'scroll_into_view') await locator.scrollIntoViewIfNeeded();
    else if (method === 'hover') await locator.hover();
    else await locator.dblclick();
  },
  captureNamedFact,
  async describe(page, selector) {
    const d = await describeElement(page, selector);
    return { role: d.role, name: d.name, text: d.text };
  },
  record: (page, selector) => recordElement(page, selector),
  action: (page, selector) => elementAction(page, selector),
  fill: (page, selector, value) => fillElement(page, selector, value),
  select: (page, selector, value) => selectElementOption(page, selector, value),
  captureFact: (page, input) => captureFact(page, input),
  captureEarlyFact: captureEarlyNotificationFact,
  notificationTexts: (page) => notificationTexts(page),
  describeField: (page, selector) => describeField(page, selector),
  value: (page, selector) => fieldValue(page, selector),
  requiredEmptyFields: (page, submit, typed) => requiredEmptyFields(page, submit, typed),
  check: (page, selector) => checkElement(page, selector),
  hittable: (page, selector) => isHittable(page, selector),
  hittableAlternative: (page, ref) => hittableAlternative(page, ref),
  namedControl: (page, name, roles) => reachableNamedControl(page, name, roles),
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
  /**
   * Judges unclear (`semantic`) criteria from what the page shows (2026-10-07); default `createCriterionJudge(ctx.llm)`.
   * Null: nothing is judged (they stay inconclusive).
   */
  judge?: CriterionJudge | null;
  /** Delay between `wait_for` polls. */
  pollIntervalMs?: number;
  /** How long a click's own requests may hold the next step (KI-049); default ACTION_REQUESTS_TIMEOUT_MS. */
  actionRequestsTimeoutMs?: number;
  /** How long a click's requests must stay settled before the next step (KI-058); default ACTION_QUIET_MS. */
  actionQuietMs?: number;
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
/**
 * How long the next step waits, after a click, for the fetch / XHR requests the click started (KI-049): a single-page
 * app's Register or Login is a fetch, not a page load, and a navigation started before it is answered cancels it.
 */
const ACTION_REQUESTS_TIMEOUT_MS = 5_000;
const ACTION_REQUESTS_POLL_MS = 50;
/**
 * How long no request of the click's may be pending before the next step goes (KI-058): a single-page app's link
 * first loads the next page's script, then changes the URL and fetches its data, with a short gap in between.
 */
const ACTION_QUIET_MS = 300;
/** The click's requests that hold the next step: data (fetch / XHR), a route's code (script) and a page load. */
const ACTION_REQUEST_TYPES = new Set(["fetch", "xhr", "script", "document"]);
/** The page's visible text, for the judge (a string: see INVENTORY_SCRIPT on why not a function). */
const VISIBLE_TEXT_SCRIPT = String.raw`(() => String((document.body && document.body.innerText) || "").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim().slice(0, ${JUDGE_TEXT_MAX_CHARS}))()`;
/** `other` steps may keep these observed methods (none takes a value); everything else clicks. */
const SAFE_OTHER_METHODS = new Set(["click", "doubleClick", "hover", "scrollIntoView"]);
/** Term matching regardless of what the run allows: what the step and the element are, not what may run. */
const DENY_DESTRUCTIVE: ActionPolicy = { allowDestructive: false };
/** Roles of a field a value is typed into: a click on one submits nothing, Enter in it may (R1). */
const TEXT_FIELD_ROLES = new Set(["textbox", "searchbox", "combobox"]);

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
  /** How a fill the executor added itself is replayed (KI-062). */
  fillMethod?: ExplorationStep["fillMethod"];
  actMethod?: ExplorationStep["actMethod"];
  /** A `judge` step's judgment (2026-10-07). */
  judgment?: CriterionJudgment;
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

/** Opening the target cannot also satisfy a request to visit a different, named page. */
function opensTargetPage(description: string, targetUrl: string): boolean {
  const url = urlInDescription(description, targetUrl);
  if (url !== null) return sameUrl(url, targetUrl);
  const text = description.replace(/\s+/g, " ").trim();
  if (/^(?:open|navigate(?: to)?|go to|visit|load)(?: (?:the )?(?:(?:target|initial|starting) )?(?:url|page|site|website|shop|store))?[.!]?$/i.test(text)) return true;
  // A home-page instruction is only satisfied by opening a root URL, not an arbitrary deep link.
  return new URL(targetUrl).pathname === "/"
    && /^(?:open|navigate to|go to|visit|load) (?:the )?(?:(?:shop|store|site|website|main)(?:'s)? )?(?:home ?page|landing page)[.!]?$/i.test(text);
}

/** A field that repeats another one ("Repeat password", "Confirm email"): it gets the value typed into that one (KI-062). */
const CONFIRM_FIELD = /\b(confirm|confirmation|repeat|re-?enter|retype|verify|again)\b/i;

/** A field's name as the page shows it, without the required marker: its label, else its placeholder or name. */
const fieldName = (f: FieldFacts): string => (f.label ?? f.placeholder ?? f.name ?? "").replace(/\*/g, "").replace(/\s+/g, " ").trim().slice(0, 100) || "field";

/** A test data key for a field name, comparable with the run's keys: "First name *" and "firstName" → first_name. */
const dataKey = (text: string): string =>
  keyWords(text)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60) || "field";

const sameUrl = (a: string, b: string): boolean => {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
};

/** Lower case, punctuation as spaces, whitespace collapsed: for comparing a control's name with a step's. */
const normalizeName = (text: string): string => text.normalize("NFKC").toLowerCase().replace(/[\p{P}\p{S}]+/gu, " ").replace(/\s+/g, " ").trim();

/** The roles a control word names; the words that name no one role (icon, menu, option, control) mean a button or a link. */
const CONTROL_ROLES: Record<string, readonly string[]> = {
  button: ["button"],
  link: ["link"],
  tab: ["tab"],
  checkbox: ["checkbox"],
  toggle: ["switch", "button", "checkbox"],
};
const ANY_CONTROL: readonly string[] = ["button", "link"];
/** What a link or button is for, after its label: "the Galaxy S27 product link" names "Galaxy S27". */
const GENERIC_NOUNS = new Set(["product", "item", "page", "card", "entry", "row", "tile", "category", "section", "list", "option"]);
/** Words before a control word that are not its name ("Click the button", "Click this link", "the first button"). */
const NOT_A_NAME = /^(?:the|a|an|this|that|its|their|first|second|third|last|next|previous|same|other|submit|primary|main)$/i;

/**
 * The control a click step names (KI-072), with the roles it can have: a quoted name, with the control word after it
 * when there is one ("Click 'Add to cart'", "Click the 'Grills' link"), else an unquoted name before a control word
 * ("Click the Add to wishlist button for the product"). Null when the step names no control: "Open the cart",
 * "Submit the login form".
 */
export function namedControl(description: string): { name: string; roles: readonly string[] } | null {
  const roleAfter = (rest: string) => {
    const word = /^\s*(\p{L}+)/u.exec(rest)?.[1]?.toLowerCase();
    return word && CONTROL_WORDS.has(word) ? (CONTROL_ROLES[word] ?? ANY_CONTROL) : ANY_CONTROL;
  };
  const quoted = /(?:^|[\s(])['"‘“]([^'"‘’“”]{2,80})['"’”]/u.exec(description);
  if (quoted) return { name: quoted[1]!.trim(), roles: roleAfter(description.slice(quoted.index + quoted[0].length)) };
  const plain = /\b(?:click|press|tap|hit|select|choose|use)\s+(?:on\s+)?(?:the\s+|a\s+|an\s+)?((?:[\p{L}\p{N}&+-]+\s+){0,5}?[\p{L}\p{N}&+-]+)\s+(button|link|tab|icon|checkbox|toggle)\b/iu.exec(description);
  if (!plain) return null;
  // Unquoted, only a label as the page writes it (capitalized, or a number): "the red button" names no control.
  const words = plain[1]!.trim().split(/\s+/);
  while (words.length > 1 && GENERIC_NOUNS.has(words.at(-1)!.toLowerCase())) words.pop();
  const name = words.join(" ");
  if (NOT_A_NAME.test(name) || !/^[\p{Lu}\p{N}]/u.test(name)) return null;
  const word = plain[2]!.toLowerCase();
  return { name, roles: CONTROL_ROLES[word] ?? ANY_CONTROL };
}

/** The names a step's description quotes: 'Grills', "New User", ‘Sign in’ (R3). */
export function quotedNames(description: string): string[] {
  const names: string[] = [];
  for (const m of description.matchAll(/(?:^|[\s(])['"‘“]([^'"‘’“”]{1,80})['"’”]/g)) {
    const name = m[1]!.trim();
    if (name !== "") names.push(name);
  }
  return names;
}

/** Words that make the name before them the control a step clicks ("the New User button"). */
const CONTROL_WORDS = new Set(["button", "link", "tab", "icon", "menu", "option", "checkbox", "toggle", "control"]);

/**
 * Whether a step's description names this control as the one it clicks (KI-050): the element's name in quotes
 * ("Click 'New User'"), or followed by a control word ("Click the New User button"); any case. A name that only
 * describes something else is not: "Submit the login form" does not name the Login link, nor "Click the New User
 * button on the Login page" the Login page.
 */
function namesControl(description: string, name: string | null): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const phrase = norm(name ?? "");
  if (phrase.length < 2) return false;
  // The step names a longer control ("the Add to wishlist button"): a "wishlist" link inside that name is not it (KI-072).
  const named = namedControl(description);
  if (named && normalizeName(named.name) !== normalizeName(phrase)) return false;
  const quoted = [...description.matchAll(/["'‘“]([^"'’”]+)["'’”]/g)].map((m) => norm(m[1]!));
  if (quoted.includes(phrase)) return true;
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const plain = norm(description.replace(/["'‘’“”]/g, " "));
  for (const m of plain.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${escaped} (\\S+)`, "gu"))) {
    if (CONTROL_WORDS.has(m[1]!)) return true;
  }
  return false;
}

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
  private readonly judge: CriterionJudge | null;
  private readonly earlyCheckpoints = new Map<string, { stepId: string; facts: Map<string, ObservedFact>; artifacts: string[] | null }>();

  constructor(
    private readonly ctx: StageContext,
    private readonly input: ExplorationInput,
    private readonly deps: ExplorationDeps,
  ) {
    const { request } = ctx;
    this.session = input.session;
    this.recorder = deps.recorder ?? playwrightRecorder;
    this.inputs = deps.inputs ?? createInputGenerator(ctx.llm);
    this.judge = deps.judge !== undefined ? deps.judge : createCriterionJudge(ctx.llm);
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
        await this.exploreScenario(scenario);
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

  /**
   * One scenario: its first action opens the target URL (see the header), then its planned steps. Its unclear
   * criteria are judged after the last step that names them (where the planner says their subject is visible), the
   * others once its last step is done (2026-10-07).
   */
  private async exploreScenario(scenario: TestScenario): Promise<void> {
    this.earlyCheckpoints.clear();
    const planned = scenario.steps;
    const targetUrl = this.ctx.request.targetUrl;
    const first = planned[0];
    const opensTarget = first?.kind === "navigate" && opensTargetPage(first.description, targetUrl);
    const judgeAfter = this.judgeSchedule(scenario);

    await this.ctx.boundary();
    await this.withRetry(() => this.navigate(targetUrl, opensTarget ? first : null));
    if (opensTarget) await this.judgeCriteria(first, judgeAfter.get(first.id) ?? []);
    for (const step of planned.slice(opensTarget ? 1 : 0)) {
      await this.ctx.boundary();
      // A model-backed wait may outlast a toast. Capture the next checkpoint's notifications as
      // soon as its preceding action succeeds, provided no other action intervenes.
      const next = step.kind !== "wait_for" && step.kind !== "capture_checkpoint"
        ? planned.slice(planned.indexOf(step) + 1).find((s) => s.kind !== "wait_for")
        : undefined;
      // What the page shows before the action, so a notification it brings up can be told apart (KI-059).
      const before = next?.kind === "capture_checkpoint" ? await this.notificationBaseline() : null;
      await this.executePlanned(step);
      if (next?.kind === "capture_checkpoint") {
        const early = await this.readEarlyCheckpoint(next, newStepId(), before);
        if (early.facts.size > 0) this.earlyCheckpoints.set(next.id, early);
      }
      await this.judgeCriteria(step, judgeAfter.get(step.id) ?? []);
    }
    await this.judgeCriteria(null, judgeAfter.get(null) ?? []);
  }

  /**
   * The scenario's unclear criteria to judge, by the planned step after which each is judged (null: at the end): the
   * `semantic` criteria of this scenario the plan does not block, each after the last step naming it.
   */
  private judgeSchedule(scenario: TestScenario): Map<string | null, AcceptanceCriterion[]> {
    const schedule = new Map<string | null, AcceptanceCriterion[]>();
    if (!this.judge) return schedule;
    const plan = this.input.plan;
    const blocked = new Set(plan.blockedCriteria.map((b) => b.criterionId));
    for (const criterion of this.input.requirement.criteria) {
      if (criterion.expectedOutcome.kind !== "semantic" || blocked.has(criterion.id)) continue;
      if (scenarioOfCriterion(plan, criterion.id).id !== scenario.id) continue;
      const after = scenario.steps.findLast((s) => s.criterionIds.includes(criterion.id))?.id ?? null;
      schedule.set(after, [...(schedule.get(after) ?? []), criterion]);
    }
    return schedule;
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
    if ((step.kind === 'navigate' || step.kind === 'other') && /^\s*(?:reload|refresh)\b/i.test(step.description)) {
      // A path mentioned in a reload instruction is not a new destination. In particular,
      // opening /search would lose the current query and test a different result set.
      return this.withRetry(() => this.navigate(this.url(), step));
    }
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
        // A search planned as a fill, then a "search" step that only submits it (no value of its own, R1): it submits
        // the field just typed into, as a search's own submit does.
        const typed = this.typed.at(-1);
        if (step.kind === "search" && !step.inputRef && typed) {
          const submit = `Find the button that submits this search, not the text field the query was typed into: ${step.description}`;
          return this.withRetry(() => this.act(step, submit, typed.located.element.selector));
        }
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
    if (this.generated.has(`${source}:${ref.key}`)) return this.generateFor(source, ref.key, step.description, NO_FIELD_FACTS);
    const field = (await this.recorder.describeField?.(this.page, located.element.selector).catch(() => null)) ?? NO_FIELD_FACTS;
    return this.generateFor(source, ref.key, step.description, field);
  }

  private async generateFor(source: "testData" | "secret", key: string, stepDescription: string, field: FieldFacts): Promise<{ value: string; llm: LlmStepUsage | null }> {
    const id = `${source}:${key}`;
    const known = this.generated.get(id);
    if (known !== undefined) return { value: known, llm: null };
    const out = await this.inputs.generate({
      source,
      key,
      stepDescription,
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
    const pointer = step.kind === 'other'
      ? /^\s*scroll\b/i.test(step.description) ? 'scroll_into_view'
        : /^\s*hover\b/i.test(step.description) ? 'hover'
          : /^\s*double[ -]?click\b/i.test(step.description) ? 'double_click'
            : located?.element.method === 'scrollIntoView' ? 'scroll_into_view'
              : located?.element.method === 'hover' ? 'hover'
                : located?.element.method === 'doubleClick' ? 'double_click' : null
      : null;
    if (pointer && this.recorder.pointerAction) {
      if (!located) return 'failed';
      await this.enforcePolicy(step, observeInstruction, located, 'act');
      await this.reserve();
      const base: Omit<StepDraft, 'outcome'> = { plannedStepId: step.id, kind: 'act', instruction: observeInstruction,
        element: located.ref, urlBefore: this.url(), startedAt: this.ctx.now(), actMethod: pointer };
      const requests = this.watchRequests();
      try {
        await this.recorder.pointerAction(this.page, located.element.selector, pointer);
        await requests.settle();
        await this.record({ ...base, outcome: 'SUCCESS', onGoldenPath: true });
        return 'ok';
      } catch (err) {
        this.rethrowIfFatal(err);
        await this.record({ ...base, outcome: 'FAILED', error: firstLine(err) });
        return 'failed';
      } finally { requests.dispose(); }
    }
    // Another control than the one the step names (the header's "wishlist" link for "the Add to wishlist button",
    // KI-072): the named one, or none (then the recoveries below run as for nothing found).
    if (located && searchField === undefined) located = await this.namedTarget(step, located);
    // A search with no submit button (R1): the model finds the field itself, or nothing. Enter in the field submits it.
    if (searchField !== undefined && (!located || located.element.selector === searchField)) {
      const field = this.typed.findLast((t) => t.located.element.selector === searchField)?.located ?? located;
      if (field) return this.click(step, observeInstruction, field, false, "press_enter");
    }
    // Not found, but the step names its control ("the Add to wishlist button", KI-072): that role and name on this page.
    if (!located && searchField === undefined) located = await this.byName(step);
    // Nothing to click on this page (e.g. a product link after the login opened the account page, KI-001): ask once
    // for the way there, follow it (policy-checked) and look again. Not for a search's submit control.
    if (!located && searchField === undefined && observeInstruction === step.description) {
      const instruction = `Find the link or button that leads to where you can: ${step.description}`;
      const way = await this.locate(step, instruction);
      if (!way) return this.linkByName(step);
      const followed = await this.click(step, instruction, way);
      if (followed !== "ok") return followed;
      // The way there was the step's own control (the model missed it, then chose it as the way, KI-050): its click
      // did the step, and the page it opened does not have it.
      if (namesControl(step.description, way.info.name ?? way.info.text)) return "ok";
      located = await this.locate(step, observeInstruction);
      if (located) located = await this.namedTarget(step, located);
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
    // A submit or click step that resolves to the text field the run just typed into ("Submit the search", "Press
    // Enter in the search field", R1): clicking it again submits nothing; Enter in it does.
    if (searchField === undefined && TEXT_FIELD_ROLES.has(located.info.role ?? "") && this.typed.some((t) => t.located.element.selector === located!.element.selector)) {
      return this.click(step, instruction, located, false, "press_enter");
    }
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
    return this.click(step, instruction, located, searchField === undefined);
  }

  /**
   * Clicks a located element: the action policy first, then the explorer; recorded as an `act` step. `completeForm`:
   * the step's own control (not a way there, not a search's button), whose form gets its empty required fields first.
   */
  private async click(
    step: PlannedStep,
    instruction: string,
    target: Located,
    completeForm = false,
    how: "click" | "press_enter" = "click",
  ): Promise<Attempt> {
    const located = how === "click" ? await this.reachable(target) : target;
    await this.enforcePolicy(step, instruction, located, "act");
    if (completeForm) await this.completeRequiredFields(step, located);
    await this.retypeCleared();
    // The click may change or replace the form: what was typed before it is not checked again.
    this.typed = [];

    await this.reserve();
    const startedAt = this.ctx.now();
    const urlBefore = this.url();
    const base = {
      plannedStepId: step.id,
      kind: "act" as const,
      instruction,
      element: located.ref,
      urlBefore,
      startedAt,
      ...(how === "press_enter" ? { actMethod: "press_enter" as const } : {}),
    };
    let result;
    const requests = this.watchRequests();
    try {
      try {
        result = await this.session.actOn(this.safeAction(located.element, step.kind, how));
      } catch (err) {
        this.rethrowIfFatal(err);
        await this.record({ ...base, outcome: "FAILED", error: firstLine(err) });
        // The click may already have been dispatched before actOn rejected: a failed report can still
        // follow a dispatched click, so a destructive step gets no retry (repeating it could delete or pay twice).
        return this.policy.allowDestructive && isDestructiveStep(step) ? "final" : "failed";
      }
      await this.settle();
      await requests.settle();
    } finally {
      requests.dispose();
    }
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
   * Fills, before the click that submits a form, the form's required fields that are still empty (KI-062): a requirement
   * such as "Fill information" names no field, so the plan fills the ones it knows (email, password) and a registration
   * form with a first name, an address and a country is submitted half empty and rejected. Only for the step's own
   * control, and only when the step submits (`submit`, `login`) or the run typed into that form since the last click:
   * a link inside a form nothing was typed into stays a plain click.
   *
   * Each field gets, in order: the value typed into the field it confirms ("Repeat password"), the run's test data whose
   * key names it, or a generated value (the generator, as for any value nobody provided; a secret for a password field).
   * A required checkbox is checked. Recorded as golden fills of the submit step with `fillMethod`, so the generated test
   * replays them; a field that cannot be recorded or filled is skipped (the form then shows why it was rejected).
   */
  private async completeRequiredFields(step: PlannedStep, located: Located): Promise<void> {
    if (!this.recorder.requiredEmptyFields) return;
    const typed = this.typed.map((t) => t.located.element.selector);
    const scan = await this.recorder.requiredEmptyFields(this.page, located.element.selector, typed).catch((err: unknown) => {
      this.rethrowIfFatal(err);
      return null;
    });
    if (!scan || scan.fields.length === 0) return;
    if (!(step.kind === "submit" || step.kind === "login" || scan.touched)) return;
    for (const field of scan.fields) await this.completeField(step, field);
  }

  private async completeField(step: PlannedStep, field: RequiredField): Promise<void> {
    const facts = (await this.recorder.describeField?.(this.page, field.selector).catch(() => null)) ?? NO_FIELD_FACTS;
    const name = fieldName(facts);
    let ref: ElementRef;
    try {
      ref = await this.recorder.record(this.page, field.selector);
    } catch (err) {
      this.rethrowIfFatal(err);
      return; // nothing the generated test could replay: left as it is
    }
    const instruction =
      field.how === "check"
        ? `Check the required field "${name}" the plan left empty`
        : field.how === "select"
          ? `Choose an option in the required field "${name}" the plan left empty`
          : `Fill the required field "${name}" the plan left empty`;
    const input = field.how === "check" ? null : await this.requiredFieldInput(facts, name, instruction);

    await this.reserve();
    const base = {
      plannedStepId: step.id,
      kind: "fill" as const,
      instruction,
      element: ref,
      inputRef: input?.inputRef ?? { source: "literal" as const, key: "on" },
      urlBefore: this.url(),
      startedAt: this.ctx.now(),
      fillMethod: field.how,
      ...(input?.generatedValue !== undefined ? { generatedValue: input.generatedValue } : {}),
      ...(input?.llm ? { llm: input.llm } : {}),
    };
    try {
      if (field.how === "check") {
        if (!this.recorder.check) throw new Error("recorder: check is not supported");
        await this.recorder.check(this.page, field.selector);
      } else if (field.how === "select") await this.recorder.select(this.page, field.selector, input!.value);
      else await this.recorder.fill(this.page, field.selector, input!.value);
    } catch (err) {
      this.rethrowIfFatal(err);
      await this.record({ ...base, outcome: "FAILED", error: firstLine(err) });
      return;
    }
    await this.record({ ...base, outcome: "SUCCESS", onGoldenPath: true });
    if (field.how === "fill") {
      const element: ObservedElement = { selector: field.selector, description: name, method: "fill", arguments: [] };
      this.typed.push({
        step,
        located: { element, ref, info: { role: null, name, text: null } },
        value: input!.value,
        ...(input!.generatedValue !== undefined ? { generatedValue: input!.generatedValue } : {}),
      });
    }
  }

  /** The value of a required field the plan left empty: the field it confirms, the run's test data, or a generated one. */
  private async requiredFieldInput(
    facts: FieldFacts,
    name: string,
    instruction: string,
  ): Promise<{ value: string; inputRef: InputRef; generatedValue?: string; llm?: LlmStepUsage | null }> {
    if (CONFIRM_FIELD.test(`${facts.label ?? ""} ${facts.name ?? ""} ${facts.placeholder ?? ""}`)) {
      for (const t of [...this.typed].reverse()) {
        if (!t.step.inputRef) continue;
        const other = await this.recorder.describeField?.(this.page, t.located.element.selector).catch(() => null);
        if (!other || other.type !== facts.type) continue;
        return { value: t.value, inputRef: t.step.inputRef, ...(t.generatedValue !== undefined ? { generatedValue: t.generatedValue } : {}) };
      }
    }
    const key = dataKey(name);
    const data = this.ctx.request.testData;
    const provided = Object.keys(data).find((k) => dataKey(k) === key);
    if (provided !== undefined && facts.type !== "password") {
      return { value: String(data[provided] ?? ""), inputRef: { source: "testData", key: provided } };
    }
    // A required select takes the site's first real option, never the model's pick (KI-064): asked for a country, the
    // model answers the United States, for which the Shopware demo's register form silently refuses to submit; a shop
    // lists the countries it serves first.
    const option = facts.options.find((o) => o.value.trim() !== "")?.value;
    if (option !== undefined) return { value: option, inputRef: { source: "testData", key }, generatedValue: option, llm: null };
    const source = facts.type === "password" ? "secret" : "testData";
    const secretKey = source === "secret" ? (this.ctx.secrets.names.find((n) => dataKey(n) === key) ?? null) : null;
    if (secretKey !== null) {
      const value = this.ctx.secrets.get(secretKey);
      if (value != null) return { value, inputRef: { source: "secret", key: secretKey } };
    }
    const generated = await this.generateFor(source, key, instruction, facts);
    return { value: generated.value, inputRef: { source, key }, generatedValue: generated.value, llm: generated.llm };
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

  /** The notifications the page shows now (KI-059); null when they cannot be read (then only a named one is captured). */
  private async notificationBaseline(): Promise<string[] | null> {
    if (!this.recorder.notificationTexts) return null;
    return this.recorder.notificationTexts(this.page).catch((err: unknown) => {
      this.rethrowIfFatal(err);
      return null;
    });
  }

  private async readEarlyCheckpoint(step: PlannedStep, stepId: string, before: readonly string[] | null = null) {
    await this.reserve();
    const checkpoint = step.checkpoint!;
    const requests = this.input.requirement.facts.filter((f) => f.checkpoint === checkpoint);
    const facts = new Map<string, ObservedFact>();
    for (const request of requests) {
      const fact = await this.recorder.captureEarlyFact?.(this.page, request, this.input.requirement.criteria, stepId, before).catch((err: unknown) => {
        this.rethrowIfFatal(err);
        return null;
      });
      if (fact) facts.set(request.key, fact);
    }
    // Keep evidence from the same moment as a transient reading, before any slow extraction/lookup.
    const artifacts = facts.size > 0 ? await this.screenshot(`${checkpoint}.png`, `at checkpoint ${checkpoint}`) : null;
    return { stepId, facts, artifacts };
  }

  private async checkpoint(step: PlannedStep): Promise<Attempt> {
    await this.reserve();
    const checkpoint = step.checkpoint!;
    const requests = this.input.requirement.facts.filter((f) => f.checkpoint === checkpoint);
    const prepared = this.earlyCheckpoints.get(step.id);
    const capture = prepared ?? await this.readEarlyCheckpoint(step, newStepId());
    if (capture.facts.size > 0) this.earlyCheckpoints.set(step.id, capture);
    const { stepId, facts: early, artifacts: earlyArtifacts } = capture;
    for (const request of requests) {
      const mode = this.modeFor(request);
      if (early.has(request.key) || !mode || !this.recorder.captureNamedFact) continue;
      const bound = await this.recorder.captureNamedFact(this.page, request, mode, stepId).catch((err: unknown) => {
        this.rethrowIfFatal(err);
        return null;
      });
      if (bound) early.set(request.key, bound);
    }
    const remaining = requests.filter((r) => !early.has(r.key));

    let values: Record<string, FactValue> = {};
    if (remaining.length > 0) {
      const extracted = await this.extract(step, remaining);
      if (!extracted) return "failed";
      values = extracted;
    }

    const captured: ObservedFact[] = [urlFact(this.page, { checkpoint, stepId })];
    for (const request of requests) {
      const observed = early.get(request.key);
      if (observed) {
        captured.push(observed);
        continue;
      }
      const mode = this.modeFor(request);
      let element: ElementRef | null = null;
      if (mode) {
        element = (await this.locate(step, this.locateInstruction(request)))?.ref ?? null;
        // A list's container not found: once more, as the element that shows it (KI-001).
        if (!element && request.valueType === "string_list") element = (await this.locate(step, `Find the element that shows: ${request.description}`))?.ref ?? null;
      }
      const capture = (modelValue: FactValue) =>
        this.recorder.captureFact(this.page, { key: request.key, checkpoint, stepId, modelValue, element, mode, description: request.description }).catch((err: unknown) => {
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
      // The model's answer and the element it located disagree, and the element shows a value: the model said "not
      // shown" (KI-001), or it read the page before it finished loading — a cart drawer read as empty while its line
      // item rendered, a results list read as missing (KI-071; the extract runs before the element is located and read).
      // Once the network is quiet, ask for that value once more, alone; the DOM reading must still equal the answer (D2),
      // so a value the two keep disagreeing on stays MODEL_EXTRACTED.
      if (fact.provenance === "MODEL_EXTRACTED" && shows(fact.domValue)) {
        await this.page.waitForLoadState("networkidle", { timeout: NETWORK_QUIET_TIMEOUT_MS }).catch(() => {});
        const again = await this.extract(step, [request]);
        const value = again?.[request.key];
        if (value !== null && value !== undefined && !factValuesEqual(value, fact.modelValue ?? null)) fact = await capture(value);
      }
      // A count of listed items ("Number of products listed in the search results") that no element shows as a number
      // (KI-071): count the list container's items; the count must equal the model's answer (D2).
      if (fact.provenance === "MODEL_EXTRACTED" && request.valueType === "number" && typeof fact.modelValue === "number" && ITEM_COUNT.test(request.description)) {
        const list = await this.locate(step, `Find the list or container whose items are counted: ${request.description}`);
        if (list) {
          const counted = await this.recorder
            .captureFact(this.page, { key: request.key, checkpoint, stepId, modelValue: fact.modelValue, element: list.ref, mode: "count", description: request.description })
            .catch((err: unknown) => {
              this.rethrowIfFatal(err);
              return null;
            });
          if (counted?.provenance === "DOM_VERIFIED") fact = counted;
        }
      }
      captured.push(fact);
    }

    await this.reserve();
    const startedAt = this.ctx.now();
    const urlBefore = this.url();
    const artifactIds = earlyArtifacts ?? await this.screenshot(`${checkpoint}.png`, `at checkpoint ${checkpoint}`);
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
    this.earlyCheckpoints.delete(step.id);
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

  /**
   * Judges unclear criteria on the page as it is now (2026-10-07): one page scan (its structure and visible text) and
   * one screenshot of the screen (the visual check, kept as the criteria's evidence), then one `judge` step per
   * criterion with the model's judgment (FAILED when the model fails: the criterion stays inconclusive). Off the golden
   * path: the generated test never replays it.
   */
  private async judgeCriteria(step: PlannedStep | null, criteria: readonly AcceptanceCriterion[]): Promise<void> {
    if (!this.judge || criteria.length === 0) return;
    await this.reserve();
    await this.page.waitForLoadState("load", { timeout: LOAD_SETTLE_TIMEOUT_MS }).catch(() => {});
    const inventory = await this.readInventory();
    const text = await this.visibleText();
    const ids = criteria.map((c) => c.id).join(", ");
    const shot = await this.capture(`judge-${criteria[0]!.id}.png`, `to judge ${ids}`, false);
    for (const criterion of criteria) {
      await this.reserve();
      const startedAt = this.ctx.now();
      const urlBefore = this.url();
      const base = {
        plannedStepId: step?.id ?? null,
        kind: "judge" as const,
        instruction: `Judge ${criterion.id} from what the page shows: ${criterion.statement}`,
        urlBefore,
        startedAt,
        artifactIds: shot.artifactIds,
      };
      try {
        const out = await this.judge.judge({
          requirement: this.input.requirement.originalText,
          criterion,
          stepDescription: step?.description ?? null,
          url: urlBefore,
          inventory,
          text,
          screenshot: shot.png,
          runId: this.ctx.runId,
          signal: this.input.budget,
          deadlineAt: this.ctx.deadlineAt,
          redact: this.ctx.redact,
        });
        await this.record({ ...base, outcome: "SUCCESS", llm: out.llm, judgment: { criterionId: criterion.id, ...out.judgment } });
      } catch (err) {
        this.rethrowIfFatal(err);
        await this.record({ ...base, outcome: "FAILED", error: firstLine(err) });
      }
    }
  }

  /** The page's visible text for the judge (redacted, clipped); empty when it cannot be read. */
  private async visibleText(): Promise<string> {
    try {
      const text: unknown = await this.page.evaluate(VISIBLE_TEXT_SCRIPT);
      return typeof text === "string" ? String(this.ctx.redact(text)).slice(0, JUDGE_TEXT_MAX_CHARS) : "";
    } catch {
      return "";
    }
  }

  /** The page's structure for the judge (redacted); null when it cannot be read. */
  private async readInventory(): Promise<PageInventory | null> {
    try {
      return toPageInventory(parseRawInventory(await this.page.evaluate(INVENTORY_SCRIPT)), this.ctx.redact);
    } catch {
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
  private async locate(step: PlannedStep, instruction: string, retried = false): Promise<Located | null> {
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
      // The explorer lost the page for a moment (KI-051): not "nothing here", which would start a recovery that
      // navigates away. Once the page settles, look once more.
      if (err instanceof ExplorerTransientError && !retried) {
        await this.settle();
        return this.locate(step, instruction, true);
      }
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
  private safeAction(element: ObservedElement, kind: PlannedStep["kind"], how: "click" | "press_enter" = "click"): ObservedElement {
    if (how === "press_enter") {
      return this.ctx.redact({ selector: element.selector, description: element.description, method: "press", arguments: ["Enter"] }) as ObservedElement;
    }
    const method = kind === "other" && element.method && SAFE_OTHER_METHODS.has(element.method) ? element.method : "click";
    return this.ctx.redact({ selector: element.selector, description: element.description, method, arguments: [] }) as ObservedElement;
  }

  /**
   * The link a step names in quotes ("Click the 'Grills' link") when neither it nor a way to it can be found (R3): e.g.
   * inside a closed side menu, which the explorer does not see. Its same-origin URL is read from the page's DOM (the
   * link's aria-label, its text or its first text, e.g. a category name above its description) and opened with a
   * navigate step, which the generated test replays as a `goto`. Only when the step clicks that link (namesControl),
   * exactly one URL matches, the host is allowed and the link is not destructive; otherwise the step fails as before.
   */
  private async linkByName(step: PlannedStep): Promise<Attempt> {
    const names = quotedNames(step.description).filter((n) => namesControl(step.description, n));
    if (names.length === 0) return "failed";
    const wanted = names.map((n) => n.toLowerCase().replace(/\s+/g, " ").trim());
    const hrefs = await this.page
      .evaluate((want: string[]) => {
        const out: string[] = [];
        for (const a of Array.from(document.querySelectorAll("a[href]"))) {
          const walker = document.createTreeWalker(a, NodeFilter.SHOW_TEXT);
          let first = "";
          for (let n = walker.nextNode(); n && !first; n = walker.nextNode()) first = (n.textContent ?? "").replace(/\s+/g, " ").trim();
          const texts = [a.getAttribute("aria-label") ?? "", a.textContent ?? "", first].map((t) => t.replace(/\s+/g, " ").trim().toLowerCase());
          if (texts.some((t) => t !== "" && want.includes(t))) out.push((a as HTMLAnchorElement).href);
        }
        return out;
      }, wanted)
      .catch(() => [] as string[]);
    const start = new URL(this.ctx.request.targetUrl);
    const urls = [...new Set(hrefs)].filter((href) => {
      try {
        const url = new URL(href);
        return /^https?:$/.test(url.protocol) && isAllowedPageHost(url, start, this.ctx.request.options.additionalAllowedHosts);
      } catch {
        return false;
      }
    });
    if (urls.length !== 1) return "failed";
    const allowed = assertActionAllowed({ instruction: step.description, elementRole: "link", elementName: names[0]! }, DENY_DESTRUCTIVE).allowed;
    if (!allowed) return "failed";
    return this.navigate(urls[0]!, step);
  }

  /** The reachable control of the role and name the step names (namedControl), or null (KI-072). */
  private async byName(step: PlannedStep): Promise<Located | null> {
    const recorder = this.recorder;
    const named = namedControl(step.description);
    if (!named || !recorder.namedControl) return null;
    try {
      const selector = await recorder.namedControl(this.page, named.name, named.roles);
      if (!selector) return null;
      const [ref, info] = await Promise.all([recorder.record(this.page, selector), recorder.describe(this.page, selector)]);
      return { element: { selector, description: named.name, method: "click", arguments: [] }, ref, info };
    } catch (err) {
      this.rethrowIfFatal(err);
      return null;
    }
  }

  /**
   * The control the step names, when the located element is another one (KI-072): "Click the 'Add to wishlist' button"
   * came back as the header's "wishlist" link, whose click opened the wishlist and added nothing. A step that names its
   * control (in quotes, or followed by a control word: namedControl) is checked against the located element's
   * accessible name and text. When neither contains that name, the first reachable element of the named role (a button
   * or link for "icon", "menu" and the like) whose name contains it is used instead, re-recorded for the generated test.
   * When the page has none, the located element is not the step's control: null (nothing found). An element with no
   * name or text at all (an unlabelled icon button) cannot be told apart and is kept.
   */
  private async namedTarget(step: PlannedStep, located: Located): Promise<Located | null> {
    const named = namedControl(step.description);
    if (!named) return located;
    const names = [located.info.name, located.info.text].map((t) => normalizeName(t ?? "")).filter((t) => t !== "");
    if (names.length === 0) return located;
    const want = normalizeName(named.name);
    if (names.some((t) => t.includes(want))) return located;
    return this.byName(step);
  }

  /**
   * The element a click should go to (R2): the located one when a click lands on it; otherwise (a carousel's
   * off-screen clone, an element under a banner) the first reachable element its role / test id / label / text
   * candidates match, re-recorded so the generated test replays that one. Unchanged when the recorder cannot tell
   * or there is no such element (the click then fails or succeeds as before).
   */
  private async reachable(located: Located): Promise<Located> {
    const recorder = this.recorder;
    if (!recorder.hittable || !recorder.hittableAlternative) return located;
    try {
      if (await recorder.hittable(this.page, located.element.selector)) return located;
      const selector = await recorder.hittableAlternative(this.page, located.ref);
      if (!selector || selector === located.element.selector) return located;
      const [ref, info] = await Promise.all([recorder.record(this.page, selector), recorder.describe(this.page, selector)]);
      return { element: { ...located.element, selector }, ref, info };
    } catch (err) {
      this.rethrowIfFatal(err);
      return located;
    }
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
      : `Find the element that shows: ${request.description}. For a form value, select the input itself, not its label. For a labeled amount, select the value in that label's row, not the label or a different row.`;
  }

  private async settle(): Promise<void> {
    await this.page.waitForLoadState("load", { timeout: LOAD_SETTLE_TIMEOUT_MS }).catch(() => {});
  }

  /**
   * The fetch / XHR / script / document requests the page's own frame starts from now on (a click's, KI-049, KI-058):
   * `settle()` waits until none has been pending for `actionQuietMs` (a route change loads its script, then fetches its
   * data), at most `actionRequestsTimeoutMs` in all. An iframe's requests (ads) and other resources (images, styles,
   * fonts) are not waited for. `dispose()` stops listening.
   */
  private watchRequests(): { settle(): Promise<void>; dispose(): void } {
    const page = this.page;
    const pending = new Set<PwRequest>();
    const onRequest = (r: PwRequest) => {
      try {
        if (ACTION_REQUEST_TYPES.has(r.resourceType()) && r.frame() === page.mainFrame()) pending.add(r);
      } catch {
        // A request without a frame (a service worker's) is not the click's.
      }
    };
    const onDone = (r: PwRequest) => void pending.delete(r);
    page.on("request", onRequest);
    page.on("requestfinished", onDone);
    page.on("requestfailed", onDone);
    return {
      settle: async () => {
        const deadline = Date.now() + (this.deps.actionRequestsTimeoutMs ?? ACTION_REQUESTS_TIMEOUT_MS);
        const quietMs = this.deps.actionQuietMs ?? ACTION_QUIET_MS;
        let quietSince = Date.now();
        for (;;) {
          const now = Date.now();
          if (pending.size > 0) quietSince = now;
          if (now >= deadline || now - quietSince >= quietMs) break;
          try {
            await sleep(ACTION_REQUESTS_POLL_MS, this.input.budget);
          } catch (err) {
            this.rethrowIfFatal(err);
            break; // the budget ran out: the next reserve() stops exploration
          }
        }
      },
      dispose: () => {
        page.off("request", onRequest);
        page.off("requestfinished", onDone);
        page.off("requestfailed", onDone);
      },
    };
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
    return (await this.capture(fileName, where, true)).artifactIds;
  }

  /** A screenshot, stored and announced: of the full page (else the viewport), or of the viewport only. */
  private async capture(fileName: string, where: string, fullPageFirst: boolean): Promise<{ artifactIds: string[]; png: Buffer | null }> {
    let png: Buffer | null = null;
    for (const fullPage of fullPageFirst ? [true, false] : [false]) {
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
      return { artifactIds: [], png: null };
    }
    const { artifactId } = await this.deps.store.saveScreenshot({ png, fileName, sensitivity: this.sensitivity });
    await this.ctx.publish({
      type: "artifact.created",
      message: `Screenshot saved ${where}`,
      payload: { artifactId, type: "SCREENSHOT", sensitivity: this.sensitivity },
    });
    return { artifactIds: [artifactId], png };
  }

  private async record(draft: StepDraft): Promise<ExplorationStep> {
    // Capture at recording time, before another browser action (including held multi-action executions).
    // Checkpoints and judgments already captured their evidence; reuse it instead of taking a duplicate.
    if (draft.artifactIds === undefined) {
      const number = this.recordedCount() + 1;
      const artifactIds = draft.outcome === "BLOCKED_BY_POLICY"
        ? await this.screenshot(`blocked-step-${number}.png`, "where exploration was blocked")
        : (await this.capture(`step-${number}.png`, `after step ${number}: ${draft.kind}`, false)).artifactIds;
      draft = { ...draft, artifactIds };
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
      ...(draft.fillMethod !== undefined ? { fillMethod: draft.fillMethod } : {}),
      ...(draft.actMethod !== undefined ? { actMethod: draft.actMethod } : {}),
      ...(draft.judgment !== undefined ? { judgment: draft.judgment } : {}),
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
