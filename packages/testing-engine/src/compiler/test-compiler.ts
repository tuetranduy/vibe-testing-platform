import {
  CriterionIdSchema,
  SecretNameSchema,
  URL_FACT_KEY,
  factRefsOf,
  stepScenario,
  type AcceptanceCriterion,
  type ElementRef,
  type ExplorationStep,
  type FactRef,
  type GeneratedTest,
  type LocatorCandidate,
  type NormalizedRequirement,
  type ObservedFact,
  type PlannedStep,
  type ProvisionalResult,
  type TestDataValue,
  type TestPlan,
} from "@platform/contracts";
import { NAMEABLE_ROLES } from "../shared/locator-policy";
import { assertSafeSource } from "./ast-guard";
import { HELPERS_SOURCE } from "./helpers-template";
import { SourceWriter, ident, lit, member } from "./source-builder";

/**
 * Playwright test compiler (Task 16): turns the discovered flow into a replayable Playwright test.
 * Pure — no I/O; the GENERATING_TEST stage persists the result (generate-stage.ts).
 *
 * Workspace: `run.spec.ts` (the source), `helpers.ts` (a fixed template, helpers-template.ts) and
 * `run-data.json` (every run value).
 *
 * Replay: the golden path (`onGoldenPath && outcome === "SUCCESS"`) in index order, up to the last
 * checkpoint a compiled criterion needs. The test opens `data.targetUrl` first (the executor's first
 * navigate is that same open); a later navigate → `page.goto` of its URL; act → click; fill → fill,
 * or selectOption when the planned step is a `select`. Elements are located with the recorded
 * (chosen) candidate exactly as the recorder's `resolveElement` does; an XPath one gets a
 * `// brittle-locator` comment and a note. Navigation and actions are hard: a failure stops the test
 * and later criteria are simply not reached.
 *
 * Assertions: each compiled criterion sits in `await test.step("[AC-n] " + statement, …)` (the
 * `[AC-n]` prefix comes first: the rerun's result parser keys on it) at the latest checkpoint it
 * references, with soft assertions only, messages `"[AC-n] " + statement`, so every reached
 * criterion is evaluated. Every checkpoint first waits for the page's load state (bounded, like the
 * executor's settle). Facts of earlier checkpoints are read into variables at their own checkpoint;
 * every fact at the criterion's own checkpoint is re-read until the whole assertion matches
 * (web-first matcher or `expect.poll` over the expression), since the page may still be updating
 * after a click. Reads and comparisons mean what the fact reader and the verifier mean (see
 * helpers-template.ts):
 *
 * - visible            → `expect.soft(locator).toBeVisible()` / `toBeHidden()`
 * - text_matches       → `toHaveText` / `toContainText` ({ ignoreCase, useInnerText }); regex and
 *                        the `url` fact are polled over the verifier's normalized text
 * - numeric_compare    → polled number vs the other side (`toBeGreaterThan`, …; eq/neq within 1e-9);
 *                        both facts at the checkpoint → their polled difference vs 0
 * - numeric_delta      → polled difference `toBeCloseTo(delta)`
 * - collection_contains → polled `listContains(readTextList(…), item)` (verifier matching); rows read through a
 *   recorded sub-element: `readItemTexts(…, data.items.itemN)`
 *
 * Not compiled (with a template-built reason): semantic outcomes (D3), provisional BLOCKED /
 * INCONCLUSIVE, a fact that is missing, MODEL_EXTRACTED, read in a mode the assertion cannot replay,
 * or captured off the replayed flow, and anything behind a golden step the test cannot replay.
 *
 * Several scenarios (V1.1 F9): one `test()` per scenario with compiled criteria, in plan order, each
 * replaying that scenario's golden steps from `data.targetUrl` in Playwright's fresh context (the executor
 * started each scenario from a cleared session), so a hard failure in one never hides another's criteria.
 * A criterion whose facts were captured in different scenarios is not compiled. One scenario compiles to
 * the single `test("discovered flow", …)` it always did.
 *
 * D11: the source holds only compiler-chosen identifiers, schema-validated criterion ids, allow-listed
 * ARIA roles and fixed template text; every string literal goes through `lit` (JSON.stringify).
 * Page text, test data, literal inputs, URLs and criterion text are referenced as `data.<path>`;
 * secrets are read from `process.env.SECRET_<NAME>` and never seen here. The source must pass the
 * AST guard before it is returned.
 */

export interface CompileTestInput {
  requirement: NormalizedRequirement;
  plan: TestPlan;
  steps: ExplorationStep[];
  facts: ObservedFact[];
  provisional: ProvisionalResult[];
  targetUrl: string;
  /** Names of the run's secrets (values never reach the compiler). */
  secretNames: string[];
  /** The run's test data (Ruling R29): values go only into run-data.json. */
  testData: Record<string, TestDataValue>;
}

/** The generated test without its id (the stage assigns it, Ruling R29). */
export type CompiledTest = Omit<GeneratedTest, "id">;

interface RunData {
  targetUrl: string;
  urls: Record<string, string>;
  locators: Record<string, Record<string, string>>;
  /** Row sub-element selectors of list reads (KI-001), keyed `itemN`. */
  items: Record<string, string>;
  inputs: Record<string, string>;
  criteria: Record<string, Record<string, string | number>>;
}

/** How a fact is read back: a DOM read mode, or the page URL for the reserved `url` fact. */
type ReadKind = NonNullable<ObservedFact["read"]>["mode"] | "url";

interface FactRead {
  ref: FactRef;
  kind: ReadKind;
  /** The recorded candidate (null for `url`). */
  candidate: LocatorCandidate | null;
  /** text_list only: the sub-element read inside each row, as recorded. */
  itemSelector: string | null;
  /** Golden-path position (within its scenario) of the checkpoint the fact was captured at. */
  position: number;
  scenario: string;
}

interface CriterionPlan {
  criterion: AcceptanceCriterion;
  /** The scenario whose flow asserts it. */
  scenario: string;
  /** Golden-path position of the latest checkpoint the criterion references: where it is asserted. */
  position: number;
  /** One per FactRef, in `factRefsOf` order. Those at `position` are re-read until they match. */
  reads: FactRead[];
}

/** Read modes an outcome can replay, per role of the fact in it. */
const TEXT_KINDS: readonly ReadKind[] = ["text", "url"];
const NUMBER_KINDS: readonly ReadKind[] = ["number", "count"];

const refKey = (ref: FactRef) => `${ref.key}@${ref.checkpoint}`;

const READ_HELPER: Partial<Record<ReadKind, string>> = {
  text: "readText",
  number: "readNumber",
  count: "readCount",
  text_list: "readTextList",
};

/** The executor's settle bound before a checkpoint is read. */
const LOAD_SETTLE_TIMEOUT_MS = 10_000;

const FLIPPED = { gt: "lt", gte: "lte", lt: "gt", lte: "gte", eq: "eq", neq: "neq" } as const;
type Operator = keyof typeof FLIPPED;

/** Why a recorded element cannot be located by the generated test, or null when it can. */
function unreplayable(element: ElementRef | null): string | null {
  if (!element) return "has no recorded element";
  if (element.framePath.length > 0) return "acts on an element inside a frame (main frame only in V1)";
  const candidate = element.candidates[element.chosenIndex];
  if (!candidate) return "has no recorded locator";
  if (candidate.strategy === "role" && !NAMEABLE_ROLES.has(candidate.role)) return "is located by a role Playwright cannot query";
  return null;
}

/** The URL a later navigate step opened: its `Navigate to <url>` instruction, else where it landed. */
function navigateUrl(step: ExplorationStep): string | null {
  const named = /^Navigate to (\S+)$/.exec(step.instruction)?.[1];
  for (const candidate of [named, step.urlAfter]) {
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      if (url.protocol === "http:" || url.protocol === "https:") return url.href;
    } catch {
      // not a URL
    }
  }
  return null;
}

/** The environment variable a generated test reads a secret from; the rerun sets exactly these (Task 17). */
export function secretEnvName(name: string): string {
  return `SECRET_${SecretNameSchema.parse(name).toUpperCase()}`;
}

export function compilePlaywrightTest(input: CompileTestInput): CompiledTest {
  return new Compiler(input).compile();
}

class Compiler {
  /** Each scenario's golden path, in index order; scenarios in plan order. */
  private readonly golden = new Map<string, ExplorationStep[]>();
  private readonly plannedKind: Map<string, PlannedStep["kind"]>;
  /** Scenario and golden position of each checkpoint step, by step id. */
  private readonly checkpointAt = new Map<string, { scenario: string; position: number }>();
  /** Why a golden step cannot be replayed, by `scenario#position`. */
  private readonly problems = new Map<string, string>();

  private readonly data: RunData;
  private readonly locatorKeys = new Map<string, string>();
  private readonly helpers = new Set<string>();
  private readonly notes: string[] = [];
  private readonly factVars = new Map<string, string>();

  constructor(private readonly input: CompileTestInput) {
    for (const s of input.plan.scenarios) this.golden.set(s.id, []);
    for (const step of [...input.steps].filter((s) => s.onGoldenPath && s.outcome === "SUCCESS").sort((a, b) => a.index - b.index)) {
      const scenario = stepScenario(step);
      this.golden.set(scenario, [...(this.golden.get(scenario) ?? []), step]);
    }
    this.plannedKind = new Map(input.plan.scenarios.flatMap((s) => s.steps).map((s) => [s.id, s.kind]));
    this.data = { targetUrl: input.targetUrl, urls: {}, locators: {}, items: {}, inputs: {}, criteria: {} };
    for (const [scenario, golden] of this.golden) {
      golden.forEach((step, position) => {
        if (step.kind === "checkpoint") this.checkpointAt.set(step.id, { scenario, position });
        const problem = this.stepProblem(step, position);
        if (problem) this.problems.set(`${scenario}#${position}`, `step ${step.index} ${problem}`);
      });
    }
  }

  compile(): CompiledTest {
    const plans: CriterionPlan[] = [];
    const notCompiled: CompiledTest["notCompiled"] = [];
    for (const criterion of this.input.requirement.criteria) {
      const planned = this.planCriterion(criterion);
      if (typeof planned === "string") notCompiled.push({ criterionId: criterion.id, reason: planned });
      else plans.push(planned);
    }

    // One test per scenario that asserts something, in plan order.
    const bodies: { scenario: string; body: SourceWriter }[] = [];
    for (const scenario of this.golden.keys()) {
      const own = plans.filter((p) => p.scenario === scenario);
      if (own.length === 0) continue;
      const body = new SourceWriter();
      this.emitFlow(body, scenario, own);
      bodies.push({ scenario, body });
    }
    const source = this.assemble(bodies);
    assertSafeSource(source);
    return {
      source,
      helpersSource: HELPERS_SOURCE,
      dataJson: `${JSON.stringify(this.data, null, 2)}\n`,
      compiledCriteria: plans.map((p) => p.criterion.id),
      notCompiled,
      notes: this.notes,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Analysis
  // -------------------------------------------------------------------------------------------

  private stepProblem(step: ExplorationStep, position: number): string | null {
    switch (step.kind) {
      case "navigate":
        return position === 0 || navigateUrl(step) ? null : "has no URL to open";
      case "act":
        return unreplayable(step.element);
      case "fill": {
        const problem = unreplayable(step.element);
        if (problem) return problem;
        const ref = step.inputRef;
        if (!ref) return "has no input reference";
        if (step.generatedValue != null) return null; // a value nobody provided, generated and typed during exploration
        if (ref.source === "secret" && !(SecretNameSchema.safeParse(ref.key).success && this.input.secretNames.includes(ref.key))) {
          return "fills a secret the run does not provide";
        }
        if (ref.source === "testData" && !Object.hasOwn(this.input.testData, ref.key)) return "fills test data the run does not provide";
        return null;
      }
      default:
        return null; // checkpoints mark positions; nothing else is replayed
    }
  }

  /** The criterion's plan, or why it is not compiled. */
  private planCriterion(criterion: AcceptanceCriterion): CriterionPlan | string {
    const outcome = criterion.expectedOutcome;
    if (outcome.kind === "semantic") return "AI-judged (semantic) criteria are never compiled";
    // The generate stage resolves test data keys first (resolveTestDataValues); one left is a value the run lacks.
    if (outcome.kind === "text_matches" && outcome.match.value === undefined) return "Its test data value was not provided";
    const provisional = this.input.provisional.find((p) => p.criterionId === criterion.id);
    if (!provisional) return "No provisional result";
    if (provisional.status !== "PASS" && provisional.status !== "FAIL") {
      return `Provisional result is ${provisional.status}${provisional.reason ? ` (${provisional.reason})` : ""}`;
    }
    CriterionIdSchema.parse(criterion.id);

    const allowed = (path: string): readonly ReadKind[] => {
      switch (outcome.kind) {
        case "visible":
          return ["visible"];
        case "text_matches":
          return TEXT_KINDS;
        case "numeric_compare":
        case "numeric_delta":
          return NUMBER_KINDS;
        case "collection_contains":
          return path === "collection" ? ["text_list"] : TEXT_KINDS;
      }
    };

    const reads: FactRead[] = [];
    for (const { ref, path } of factRefsOf(outcome)) {
      const label = `Fact ${refKey(ref)}`;
      // A fact recorded more than once: the last reading counts, as for the verifier and reconcile.
      const fact = this.input.facts.findLast((f) => f.key === ref.key && f.checkpoint === ref.checkpoint);
      if (!fact) return `${label} was not recorded`;
      if (fact.provenance !== "DOM_VERIFIED") return `${label} was extracted by the model, not read from the page`;
      const where = this.checkpointAt.get(fact.stepId);
      if (where === undefined) return `${label} was not captured on the replayed flow`;
      const { position, scenario } = where;
      let kind: ReadKind;
      let candidate: LocatorCandidate | null = null;
      let itemSelector: string | null = null;
      if (fact.key === URL_FACT_KEY) {
        kind = "url";
      } else {
        if (!fact.read) return `${label} was not read from the page`;
        kind = fact.read.mode;
        const problem = unreplayable(fact.read.element);
        if (problem) return `${label} is read through an element the test cannot locate`;
        candidate = fact.read.element.candidates[fact.read.element.chosenIndex]!;
        itemSelector = fact.read.itemSelector ?? null;
      }
      if (!allowed(path[0]!).includes(kind)) return `${label} was read as ${kind}, which this assertion cannot replay`;
      reads.push({ ref, kind, candidate, itemSelector, position, scenario });
    }

    const scenario = reads[0]!.scenario;
    if (reads.some((r) => r.scenario !== scenario)) return "Its facts were captured in different scenarios";
    const position = Math.max(...reads.map((r) => r.position));
    for (let p = 0; p < position; p++) {
      const problem = this.problems.get(`${scenario}#${p}`);
      if (problem) return `The discovered flow cannot be replayed: ${problem}`;
    }
    return { criterion, scenario, position, reads };
  }

  // -------------------------------------------------------------------------------------------
  // Emission
  // -------------------------------------------------------------------------------------------

  private emitFlow(w: SourceWriter, scenario: string, plans: CriterionPlan[]): void {
    const cutoff = Math.max(...plans.map((p) => p.position));
    // Facts read into variables at their own checkpoint: those of a checkpoint before the criterion's.
    // Facts at the criterion's own checkpoint are re-read inside its poll (the page may still be updating).
    const saved = new Map<number, FactRead[]>();
    for (const plan of plans) {
      for (const read of plan.reads) {
        if (read.position === plan.position) continue;
        const list = saved.get(read.position) ?? [];
        if (!list.some((r) => refKey(r.ref) === refKey(read.ref))) list.push(read);
        saved.set(read.position, list);
      }
    }

    w.line("await page.goto(data.targetUrl);");
    let checkpoints = 0;
    (this.golden.get(scenario) ?? []).forEach((step, position) => {
      if (position > cutoff) return;
      switch (step.kind) {
        case "navigate":
          if (position > 0) w.line(`await page.goto(${this.url(navigateUrl(step)!)});`);
          return;
        case "act":
          this.withLocator(w, step.element!, `Step ${step.index} (act)`, (l) => `await ${l}.click();`);
          return;
        case "fill": {
          const value = this.inputValue(step);
          const method = step.plannedStepId && this.plannedKind.get(step.plannedStepId) === "select" ? "selectOption" : "fill";
          this.withLocator(w, step.element!, `Step ${step.index} (fill)`, (l) => `await ${l}.${method}(${value});`);
          return;
        }
        case "checkpoint":
          w.comment(`Checkpoint ${++checkpoints}`);
          // Like the executor's settle before it read the page (best effort, bounded).
          w.line(`await page.waitForLoadState(${lit("load")}, { timeout: ${lit(LOAD_SETTLE_TIMEOUT_MS)} }).catch(() => {});`);
          for (const read of saved.get(position) ?? []) this.emitSavedRead(w, read);
          for (const plan of plans) if (plan.position === position) this.emitCriterion(w, plan);
          return;
        default:
          return;
      }
    });
  }

  private assemble(bodies: { scenario: string; body: SourceWriter }[]): string {
    const w = new SourceWriter();
    w.comment("Generated by the AI testing platform from a discovered flow. Do not edit.");
    w.comment("Values live in run-data.json; secrets are read from SECRET_* environment variables.");
    w.line('import { expect, test } from "@playwright/test";');
    if (this.helpers.size > 0) w.line(`import { ${[...this.helpers].sort().map(ident).join(", ")} } from "./helpers";`);
    w.line('import data from "./run-data.json";');
    w.line();
    w.line("const softExpect = expect.configure({ soft: true });");
    w.line();
    const several = bodies.length > 1 || (bodies.length === 1 && this.golden.size > 1);
    bodies.forEach(({ scenario, body }, i) => {
      if (i > 0) w.line();
      const inner = body.toString().trimEnd();
      const title = several ? `scenario ${scenario}` : "discovered flow";
      w.block(`test(${lit(title)}, async ({ page }) => {`, () => {
        for (const line of inner.split("\n")) w.line(line);
      }, "});");
    });
    // Nothing compiled: still a valid (empty) test file.
    if (bodies.length === 0) w.block(`test(${lit("discovered flow")}, async ({ page }) => {`, () => {}, "});");
    return w.toString();
  }

  private emitSavedRead(w: SourceWriter, read: FactRead): void {
    const name = ident(`fact${this.factVars.size + 1}`);
    this.factVars.set(refKey(read.ref), name);
    this.withReads(w, [read], (l) => (read.candidate ? `const ${name} = await ${this.readCall(read, l)};` : `const ${name} = page.url();`));
  }

  private emitCriterion(w: SourceWriter, plan: CriterionPlan): void {
    const id = plan.criterion.id;
    const entry: Record<string, string | number> = { statement: plan.criterion.statement };
    this.data.criteria[id] = entry;
    const criterionData = member("data.criteria", id);
    const title = `${lit(`[${id}] `)} + ${criterionData}.statement`;
    const param = (name: string, value: string | number) => {
      entry[name] = value;
      return `${criterionData}.${ident(name)}`;
    };

    w.block(`await test.step(${title}, async () => {`, () => {
      w.line(`const message = ${title};`);
      for (const read of plan.reads) {
        if (read.position !== plan.position) w.line(`expect.soft(${this.factVars.get(refKey(read.ref))!}, message).not.toBeNull();`);
      }
      this.emitAssertion(w, plan, param);
    }, "});");
  }

  private emitAssertion(w: SourceWriter, plan: CriterionPlan, param: (name: string, value: string | number) => string): void {
    const outcome = plan.criterion.expectedOutcome;
    const isFresh = (read: FactRead) => read.position === plan.position;
    const fresh = plan.reads.filter(isFresh);
    /** A fact's value inside the poll callback: re-read when at the criterion's checkpoint, else its variable. */
    const valueOf = (read: FactRead): string => (isFresh(read) ? this.freshRead(read) : this.factVars.get(refKey(read.ref))!);
    const variableOf = (read: FactRead) => this.factVars.get(refKey(read.ref))!;
    const readOf = (path: string) => plan.reads[factRefsOf(outcome).findIndex((r) => r.path[0] === path)]!;
    const poll = (value: string) => `await softExpect.poll(${value.includes("await ") ? "async " : ""}() => ${value}, { message })`;
    /** Emits one assertion over the fresh reads (brittle-locator comment when any is an XPath). */
    const assert = (build: (locator: string) => string) => this.withReads(w, fresh, build);

    switch (outcome.kind) {
      case "visible":
        assert((l) => `await expect.soft(${l}, message).${outcome.expected ? "toBeVisible" : "toBeHidden"}();`);
        return;

      case "text_matches": {
        const read = fresh[0]!;
        const { mode, caseSensitive } = outcome.match;
        const value = outcome.match.value!; // planCriterion compiles only a check with a value
        if (mode === "regex") {
          const pattern = param("pattern", value);
          const text = `${this.helper("collapseText")}(${this.freshRead(read)})`;
          assert(() => `${poll(text)}.toMatch(new RegExp(${pattern}, ${lit(caseSensitive ? "" : "i")}));`);
          return;
        }
        const expected = param("value", value);
        if (read.kind === "url") {
          const normalize = this.helper(caseSensitive ? "collapseText" : "foldText");
          const pollMatcher = mode === "equals" ? "toBe" : "toContain";
          assert(() => `${poll(`${normalize}(page.url())`)}.${pollMatcher}(${normalize}(${expected}));`);
          return;
        }
        const matcher = mode === "equals" ? "toHaveText" : "toContainText";
        assert((l) => `await expect.soft(${l}, message).${matcher}(${expected}, { ignoreCase: ${lit(!caseSensitive)}, useInnerText: true });`);
        return;
      }

      case "numeric_compare": {
        // Polled on the left; a fixed side from an earlier checkpoint on the right (the operator flips
        // when the fresh fact is the right-hand one). Both fresh → their polled difference against 0.
        let operator: Operator = outcome.operator;
        let polled: string;
        let other: string;
        const left = readOf("left");
        if (typeof outcome.right === "number") {
          polled = this.freshRead(left, false);
          other = param("right", outcome.right);
        } else {
          const right = readOf("right");
          if (isFresh(left) && isFresh(right)) {
            polled = `${this.helper("difference")}(${this.freshRead(left)}, ${this.freshRead(right)})`;
            other = lit(0);
          } else if (isFresh(left)) {
            polled = this.freshRead(left, false);
            other = `${variableOf(right)} ?? Number.NaN`;
          } else {
            polled = this.freshRead(right, false);
            other = `${variableOf(left)} ?? Number.NaN`;
            operator = FLIPPED[operator];
          }
        }
        const matcher = {
          gt: `toBeGreaterThan(${other})`,
          gte: `toBeGreaterThanOrEqual(${other})`,
          lt: `toBeLessThan(${other})`,
          lte: `toBeLessThanOrEqual(${other})`,
          eq: `toBeCloseTo(${other}, 9)`,
          neq: `not.toBeCloseTo(${other}, 9)`,
        }[operator];
        assert(() => `${poll(polled)}.${matcher};`);
        return;
      }

      case "numeric_delta": {
        const change = `${this.helper("difference")}(${valueOf(readOf("after"))}, ${valueOf(readOf("before"))})`;
        const delta = param("delta", outcome.delta);
        assert(() => `${poll(change)}.toBeCloseTo(${delta}, 9);`);
        return;
      }

      case "collection_contains": {
        const item = typeof outcome.item === "string" ? param("item", outcome.item) : valueOf(readOf("item"));
        const found = `${this.helper("listContains")}(${valueOf(readOf("collection"))}, ${item}, ${lit(outcome.match)})`;
        assert(() => `${poll(found)}.toBe(true);`);
        return;
      }

      case "semantic":
        throw new Error("compiler: semantic criteria are never compiled");
    }
  }

  // -------------------------------------------------------------------------------------------
  // Building blocks
  // -------------------------------------------------------------------------------------------

  /** A fresh read of a fact (`await readX(locator)`, or `page.url()`); `awaited: false` → the bare promise. */
  private freshRead(read: FactRead, awaited = true): string {
    if (!read.candidate) return "page.url()";
    // No attach wait inside a poll (the poll retries; a read must not outlast its timeout).
    const call = this.readCall(read, this.locator(read.candidate), "0");
    return awaited ? `await ${call}` : call;
  }

  /** The helper call reading a fact at `locator` (a list read through a row sub-element: `readItemTexts`, selector from data). */
  private readCall(read: FactRead, locator: string, waitMs?: string): string {
    const wait = waitMs === undefined ? "" : `, ${waitMs}`;
    if (read.itemSelector === null) return `${this.helper(READ_HELPER[read.kind]!)}(${locator}${wait})`;
    let key = Object.entries(this.data.items).find(([, selector]) => selector === read.itemSelector)?.[0];
    if (!key) {
      key = ident(`item${Object.keys(this.data.items).length + 1}`);
      this.data.items[key] = read.itemSelector;
    }
    return `${this.helper("readItemTexts")}(${locator}, data.items.${key}${wait})`;
  }

  /**
   * Emits a statement that uses an element's locator, preceded by `// brittle-locator` (and noted
   * once) when that locator is an XPath. `build` gets the locator expression.
   */
  private withLocator(w: SourceWriter, element: ElementRef, what: string, build: (locator: string) => string): void {
    const candidate = element.candidates[element.chosenIndex]!;
    this.flagBrittle(w, [{ candidate, what }]);
    w.line(build(this.locator(candidate)));
  }

  /**
   * Emits a statement over fact reads (brittle-locator comment when any of them is an XPath). `build`
   * gets the first read's locator expression (`page` for the URL fact, which has no element).
   */
  private withReads(w: SourceWriter, reads: FactRead[], build: (locator: string) => string): void {
    this.flagBrittle(w, reads.map((r) => ({ candidate: r.candidate, what: `Fact ${refKey(r.ref)}` })));
    const first = reads[0]?.candidate;
    w.line(build(first ? this.locator(first) : "page"));
  }

  private flagBrittle(w: SourceWriter, uses: { candidate: LocatorCandidate | null; what: string }[]): void {
    const brittle = uses.filter((u) => u.candidate?.strategy === "xpath");
    if (brittle.length === 0) return;
    w.comment("brittle-locator");
    for (const { what } of brittle) {
      const note = `${what} is located by XPath (brittle-locator): it breaks when the page layout changes`;
      if (!this.notes.includes(note)) this.notes.push(note);
    }
  }

  /** The Playwright locator for a recorded candidate (the recorder's `locatorFor`), values from data. */
  private locator(c: LocatorCandidate): string {
    const identity = JSON.stringify(c);
    let key = this.locatorKeys.get(identity);
    if (!key) {
      key = ident(`loc${this.locatorKeys.size + 1}`);
      this.locatorKeys.set(identity, key);
      this.data.locators[key] =
        c.strategy === "role"
          ? { name: c.name }
          : c.strategy === "label" || c.strategy === "placeholder" || c.strategy === "text"
            ? { text: c.text }
            : c.strategy === "testId"
              ? { value: c.value }
              : { selector: `${c.strategy}=${c.selector}` };
    }
    const d = `data.locators.${key}`;
    switch (c.strategy) {
      case "role":
        if (!NAMEABLE_ROLES.has(c.role)) throw new Error("compiler: unsupported role");
        return `page.getByRole(${lit(c.role)}, { name: ${d}.name, exact: ${lit(c.exact)} })`;
      case "label":
        return `page.getByLabel(${d}.text, { exact: true })`;
      case "placeholder":
        return `page.getByPlaceholder(${d}.text, { exact: true })`;
      case "text":
        return `page.getByText(${d}.text, { exact: ${lit(c.exact)} })`;
      case "testId":
        return `page.getByTestId(${d}.value)`;
      case "css":
      case "xpath":
        return `page.locator(${d}.selector)`;
    }
  }

  /**
   * The value a fill step types: a secret from the environment, else a run-data input. A value generated during
   * exploration (nobody provided it, 2026-10-07) is a run-data input too, a secret's included: a rerun needs nothing typed.
   */
  private inputValue(step: ExplorationStep): string {
    const ref = step.inputRef!;
    if (ref.source === "secret" && step.generatedValue == null) return `${this.helper("secret")}(process.env.${ident(secretEnvName(ref.key))})`;
    const value = step.generatedValue ?? (ref.source === "testData" ? String(this.input.testData[ref.key] ?? "") : ref.key);
    const key = ident(`input${Object.keys(this.data.inputs).length + 1}`);
    this.data.inputs[key] = value;
    return `data.inputs.${key}`;
  }

  private url(href: string): string {
    const key = ident(`url${Object.keys(this.data.urls).length + 1}`);
    this.data.urls[key] = href;
    return `data.urls.${key}`;
  }

  private helper(name: string): string {
    this.helpers.add(name);
    return ident(name);
  }
}
