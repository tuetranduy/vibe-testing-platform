import {
  ProvisionalResultSchema,
  type AcceptanceCriterion,
  type BlockedCriterion,
  type ExpectedOutcome,
  type ExplorationStep,
  type ExplorationStopReason,
  type FactRef,
  type FactValue,
  type NormalizedRequirement,
  type ObservedFact,
  type PlannedStep,
  type ProvisionalResult,
  type TestPlan,
} from "@platform/contracts";
import { describe, expect, it } from "vitest";
import { verifyCriterion } from "./verifier";

// ---------------------------------------------------------------------------------------------
// Fixtures: a cart scenario and a login scenario, with steps and facts as the executor records them
// ---------------------------------------------------------------------------------------------

const before = { key: "cartCount", checkpoint: "before_add" } as const;
const after = { key: "cartCount", checkpoint: "after_add" } as const;
const items = { key: "cartItems", checkpoint: "cart_page" } as const;
const title = { key: "pageTitle", checkpoint: "cart_page" } as const;
const banner = { key: "errorBanner", checkpoint: "cart_page" } as const;
const selected = { key: "productName", checkpoint: "before_add" } as const;
const REFS = { before, after, items, title, banner, selected };
type RefName = keyof typeof REFS;

const TARGET = "https://shop.example.com/";
const element = { candidates: [{ strategy: "testId" as const, value: "x" }], chosenIndex: 0, framePath: [] };

const planned = (id: string, kind: PlannedStep["kind"], extra: Partial<PlannedStep> = {}): PlannedStep => ({
  id,
  kind,
  description: `${kind} ${id}`,
  criterionIds: [],
  destructive: false,
  ...extra,
});

const planOf = (steps: PlannedStep[], blockedCriteria: BlockedCriterion[] = []): TestPlan => ({
  runId: "run_1",
  requirementRevision: 1,
  scenarios: [{ id: "SC-1", title: "Scenario", criterionIds: ["AC-1"], steps }],
  blockedCriteria,
  stopConditions: [],
});

const cartPlan = planOf([
  planned("PS-1", "navigate"),
  planned("PS-2", "capture_checkpoint", { checkpoint: "before_add" }),
  planned("PS-3", "click"),
  planned("PS-4", "capture_checkpoint", { checkpoint: "after_add" }),
  planned("PS-5", "click"),
  planned("PS-6", "capture_checkpoint", { checkpoint: "cart_page" }),
]);

let seq = 0;
const step = (
  index: number,
  plannedStepId: string | null,
  kind: ExplorationStep["kind"],
  extra: Partial<ExplorationStep> = {},
): ExplorationStep => ({
  id: `st_${index}_${++seq}`,
  runId: "run_1",
  index,
  plannedStepId,
  kind,
  instruction: `${kind} ${plannedStepId}`,
  element: null,
  inputRef: null,
  onGoldenPath: extra.outcome === undefined || extra.outcome === "SUCCESS",
  urlBefore: TARGET,
  urlAfter: TARGET,
  outcome: "SUCCESS",
  blockReason: null,
  error: null,
  startedAt: "2026-09-26T10:00:00.000Z",
  durationMs: 10,
  artifactIds: [],
  llm: null,
  ...extra,
});

const fact = (ref: FactRef, value: FactValue, stepId: string, provenance: ObservedFact["provenance"] = "DOM_VERIFIED"): ObservedFact => ({
  ...ref,
  value,
  provenance,
  read: ref.key === "url" || provenance === "MODEL_EXTRACTED" ? null : { element, mode: "text" },
  stepId,
});

/** A full, successful cart exploration: one checkpoint step per checkpoint. */
function cartExploration() {
  const steps = [
    step(0, "PS-1", "navigate"),
    step(1, "PS-2", "checkpoint"),
    step(2, "PS-3", "act"),
    step(3, "PS-4", "checkpoint"),
    step(4, "PS-5", "act"),
    step(5, "PS-6", "checkpoint"),
  ];
  const checkpointStep: Record<string, ExplorationStep> = { before_add: steps[1]!, after_add: steps[3]!, cart_page: steps[5]! };
  return { steps, checkpointStep };
}

const criterion = (expectedOutcome: ExpectedOutcome, extra: Partial<AcceptanceCriterion> = {}): AcceptanceCriterion => ({
  id: "AC-1",
  sourceText: "The cart count should increase.",
  statement: "The cart count increases after adding a product",
  expectedOutcome,
  preconditions: [],
  critical: true,
  ambiguity: null,
  ...extra,
});

interface RunOptions {
  values?: Partial<Record<RefName, FactValue>>;
  provenance?: ObservedFact["provenance"];
  facts?: ObservedFact[];
  steps?: ExplorationStep[];
  stopReason?: ExplorationStopReason;
  plan?: TestPlan;
  blocked?: BlockedCriterion[];
  criterion?: Partial<AcceptanceCriterion>;
}

/** Runs the verifier over a cart exploration whose facts carry `values`; the result must match the contract. */
function run(rule: ExpectedOutcome, opts: RunOptions = {}): ProvisionalResult {
  const { steps, checkpointStep } = cartExploration();
  const facts =
    opts.facts ??
    Object.entries(opts.values ?? {}).map(([name, value]) => {
      const ref = REFS[name as RefName];
      return fact(ref, value as FactValue, checkpointStep[ref.checkpoint]!.id, opts.provenance);
    });
  const plan = opts.plan ?? cartPlan;
  const result = verifyCriterion({
    criterion: criterion(rule, opts.criterion),
    facts,
    blocked: opts.blocked ?? plan.blockedCriteria,
    steps: opts.steps ?? steps,
    stopReason: opts.stopReason ?? "COMPLETED",
    plan,
  });
  return ProvisionalResultSchema.parse(result);
}
const verify = (rule: ExpectedOutcome, values: Partial<Record<RefName, FactValue>>) => run(rule, { values }).status;
const statusOf = (r: ProvisionalResult) => [r.status, r.reason];

// ---------------------------------------------------------------------------------------------
// Step 1: rules
// ---------------------------------------------------------------------------------------------

describe("numeric_compare", () => {
  const rule = { kind: "numeric_compare", left: after, operator: "gt", right: before } as const;

  it("count after > count before (brief)", () => {
    expect(verify(rule, { before: 0, after: 1 })).toBe("PASS");
    expect(verify(rule, { before: 1, after: 1 })).toBe("FAIL");
  });

  it.each([
    ["eq", 3, 3, "PASS"],
    ["eq", 3, 4, "FAIL"],
    ["neq", 3, 4, "PASS"],
    ["neq", 3, 3, "FAIL"],
    ["gt", 4, 3, "PASS"],
    ["gt", 3, 3, "FAIL"],
    ["gte", 3, 3, "PASS"],
    ["gte", 2, 3, "FAIL"],
    ["lt", 2, 3, "PASS"],
    ["lt", 3, 3, "FAIL"],
    ["lte", 3, 3, "PASS"],
    ["lte", 4, 3, "FAIL"],
  ] as const)("%s: %d vs literal %d → %s", (operator, left, right, expected) => {
    expect(verify({ kind: "numeric_compare", left: after, operator, right }, { after: left })).toBe(expected);
  });

  it("eq tolerates floating-point representation (0.1 + 0.2 = 0.3)", () => {
    expect(verify({ kind: "numeric_compare", left: after, operator: "eq", right: 0.3 }, { after: 0.1 + 0.2 })).toBe("PASS");
  });

  it("builds expected / actual from templates", () => {
    const pass = run(rule, { values: { before: 0, after: 1 } });
    expect(pass).toMatchObject({
      status: "PASS",
      reason: null,
      expected: "Cart count after add > before add",
      actual: "Cart count after add (1) > before add (0)",
    });
    expect(run(rule, { values: { before: 1, after: 1 } })).toMatchObject({
      status: "FAIL",
      reason: null,
      actual: "Cart count after add (1) is not > before add (1)",
    });
    expect(run({ kind: "numeric_compare", left: after, operator: "gte", right: 2 }, { values: { after: 1 } })).toMatchObject({
      expected: "Cart count after add >= 2",
      actual: "Cart count after add (1) is not >= 2",
    });
  });

  it("a text value counts only when it is wholly a number (\" 1,299.50 \"); text around a number is not a number", () => {
    expect(verify({ kind: "numeric_compare", left: after, operator: "eq", right: 3 }, { after: "3" })).toBe("PASS");
    expect(verify({ kind: "numeric_compare", left: after, operator: "eq", right: 1299.5 }, { after: " 1,299.50 " })).toBe("PASS");
    expect(statusOf(run({ kind: "numeric_compare", left: after, operator: "eq", right: 17 }, { values: { after: "iPhone 17 Pro" } }))).toEqual([
      "INCONCLUSIVE",
      "FACT_NOT_OBSERVED",
    ]);
  });

  it.each([null, "none", "Cart (3)", true, ["1"]] as const)("a value of the wrong type (%j) → INCONCLUSIVE / FACT_NOT_OBSERVED, never FAIL", (value) => {
    expect(statusOf(run(rule, { values: { before: 0, after: value as FactValue } }))).toEqual(["INCONCLUSIVE", "FACT_NOT_OBSERVED"]);
  });

  it("lists every FactRef the rule used", () => {
    expect(run(rule, { values: { before: 0, after: 1 } }).factRefs).toEqual([after, before]);
    expect(run({ kind: "numeric_compare", left: after, operator: "eq", right: 1 }, { values: { after: 1 } }).factRefs).toEqual([after]);
  });
});

describe("numeric_delta", () => {
  it("brief cases", () => {
    expect(verify({ kind: "numeric_delta", before, after, delta: 1 }, { before: 1, after: 2 })).toBe("PASS");
    expect(verify({ kind: "numeric_delta", before, after, delta: 1 }, { before: 1, after: 1 })).toBe("FAIL");
  });

  it("negative deltas (removing an item)", () => {
    expect(verify({ kind: "numeric_delta", before, after, delta: -1 }, { before: 2, after: 1 })).toBe("PASS");
    expect(verify({ kind: "numeric_delta", before, after, delta: -1 }, { before: 2, after: 3 })).toBe("FAIL");
  });

  it("builds expected / actual from templates and lists both refs", () => {
    const r = run({ kind: "numeric_delta", before, after, delta: 1 }, { values: { before: 1, after: 2 } });
    expect(r).toMatchObject({
      expected: "Cart count after add - before add = +1",
      actual: "Cart count after add (2) - before add (1) = +1",
      factRefs: [before, after],
    });
    expect(run({ kind: "numeric_delta", before, after, delta: 1 }, { values: { before: 1, after: 1 } }).actual).toBe(
      "Cart count after add (1) - before add (1) = 0, not +1",
    );
  });

  it("a null before value → INCONCLUSIVE / FACT_NOT_OBSERVED", () => {
    expect(statusOf(run({ kind: "numeric_delta", before, after, delta: 1 }, { values: { before: null, after: 1 } }))).toEqual([
      "INCONCLUSIVE",
      "FACT_NOT_OBSERVED",
    ]);
  });
});

describe("collection_contains", () => {
  const rule = { kind: "collection_contains", collection: items, item: "iPhone 17 Pro", match: "contains" } as const;

  it("brief cases", () => {
    expect(verify(rule, { items: ["iPhone 17 Pro"] })).toBe("PASS");
    expect(verify(rule, { items: [] })).toBe("FAIL");
  });

  it("contains mode is case- and whitespace-insensitive", () => {
    expect(verify({ ...rule, item: "  IPHONE 17   pro " }, { items: ["USB-C cable", "Apple iPhone\n17 Pro (256 GB)"] })).toBe("PASS");
    expect(verify({ ...rule, item: "iPhone 16" }, { items: ["Apple iPhone 17 Pro"] })).toBe("FAIL");
  });

  it("equals mode matches a whole item after whitespace normalization", () => {
    expect(verify({ ...rule, match: "equals" }, { items: ["  iPhone  17 Pro "] })).toBe("PASS");
    expect(verify({ ...rule, match: "equals" }, { items: ["Apple iPhone 17 Pro"] })).toBe("FAIL");
  });

  it("the item may itself be a fact (the product chosen earlier)", () => {
    const byRef = { ...rule, item: selected };
    expect(verify(byRef, { selected: "iPhone 17 Pro", items: ["iPhone 17 Pro"] })).toBe("PASS");
    expect(verify(byRef, { selected: "Pixel 10", items: ["iPhone 17 Pro"] })).toBe("FAIL");
    expect(run(byRef, { values: { selected: "iPhone 17 Pro", items: ["iPhone 17 Pro"] } }).factRefs).toEqual([items, selected]);
  });

  it("an item fact that is not a string (a number, a boolean) → INCONCLUSIVE / FACT_NOT_OBSERVED, never FAIL", () => {
    const byRef = { ...rule, item: selected };
    expect(statusOf(run(byRef, { values: { selected: 17, items: ["iPhone 16 Pro"] } }))).toEqual(["INCONCLUSIVE", "FACT_NOT_OBSERVED"]);
    expect(statusOf(run(byRef, { values: { selected: 17, items: ["iPhone 17 Pro"] } }))).toEqual(["INCONCLUSIVE", "FACT_NOT_OBSERVED"]);
    expect(statusOf(run(byRef, { values: { selected: true, items: ["true"] } }))).toEqual(["INCONCLUSIVE", "FACT_NOT_OBSERVED"]);
  });

  it("builds expected / actual from templates", () => {
    expect(run(rule, { values: { items: ["iPhone 17 Pro"] } })).toMatchObject({
      expected: 'Cart items cart page has an item containing "iPhone 17 Pro"',
      actual: 'Cart items cart page (1 item): ["iPhone 17 Pro"]',
    });
    expect(run(rule, { values: { items: [] } }).actual).toBe("Cart items cart page (0 items): []");
  });

  it("a collection that is not a list → INCONCLUSIVE / FACT_NOT_OBSERVED", () => {
    expect(statusOf(run(rule, { values: { items: "iPhone 17 Pro" } }))).toEqual(["INCONCLUSIVE", "FACT_NOT_OBSERVED"]);
    expect(statusOf(run(rule, { values: { items: null } }))).toEqual(["INCONCLUSIVE", "FACT_NOT_OBSERVED"]);
  });
});

describe("text_matches", () => {
  const match = (mode: "equals" | "contains" | "regex", value: string, caseSensitive = false) =>
    ({ kind: "text_matches", fact: title, match: { mode, value, caseSensitive } }) as const;

  it("equals: whitespace-normalized, case-insensitive unless caseSensitive", () => {
    expect(verify(match("equals", "Order CONFIRMED"), { title: "  order\n  confirmed " })).toBe("PASS");
    expect(verify(match("equals", "Order CONFIRMED", true), { title: "Order confirmed" })).toBe("FAIL");
    expect(verify(match("equals", "Order confirmed", true), { title: " Order  confirmed" })).toBe("PASS");
    expect(verify(match("equals", "Order"), { title: "Order confirmed" })).toBe("FAIL");
  });

  it("contains", () => {
    expect(verify(match("contains", "confirmed"), { title: "Your ORDER is Confirmed!" })).toBe("PASS");
    expect(verify(match("contains", "Confirmed", true), { title: "Your order is confirmed" })).toBe("FAIL");
    expect(verify(match("contains", "shipped"), { title: "Your order is confirmed" })).toBe("FAIL");
  });

  it("regex, honouring caseSensitive", () => {
    expect(verify(match("regex", "^order #\\d+ confirmed$"), { title: "Order #1234   confirmed" })).toBe("PASS");
    expect(verify(match("regex", "^order #\\d+", true), { title: "Order #1234" })).toBe("FAIL");
    expect(verify(match("regex", "#\\d{5}"), { title: "Order #1234" })).toBe("FAIL");
  });

  it("an invalid regex → INCONCLUSIVE / AMBIGUOUS_CRITERION, not a crash", () => {
    const r = run(match("regex", "(unclosed[", false), { values: { title: "anything" } });
    expect(statusOf(r)).toEqual(["INCONCLUSIVE", "AMBIGUOUS_CRITERION"]);
  });

  it("only a string is text: a number, list or null value → INCONCLUSIVE / FACT_NOT_OBSERVED, never FAIL", () => {
    expect(statusOf(run(match("equals", "3"), { values: { title: 3 } }))).toEqual(["INCONCLUSIVE", "FACT_NOT_OBSERVED"]);
    // "price equals '1,299.00'" over a number fact read as 1299 must not become a FAIL.
    expect(statusOf(run(match("equals", "1,299.00"), { values: { title: 1299 } }))).toEqual(["INCONCLUSIVE", "FACT_NOT_OBSERVED"]);
    expect(statusOf(run(match("equals", "3"), { values: { title: ["3"] } }))).toEqual(["INCONCLUSIVE", "FACT_NOT_OBSERVED"]);
    expect(statusOf(run(match("equals", "3"), { values: { title: null } }))).toEqual(["INCONCLUSIVE", "FACT_NOT_OBSERVED"]);
  });

  it("a test data key the run has no value for (left unresolved) → BLOCKED / MISSING_TEST_DATA, never evaluated (KI-001)", () => {
    const keyed = { kind: "text_matches", fact: title, match: { mode: "contains", testDataKey: "email", caseSensitive: false } } as const;
    const r = run(keyed, { values: { title: "qa@demo.test" } });
    expect(statusOf(r)).toEqual(["BLOCKED", "MISSING_TEST_DATA"]);
    expect(r).toMatchObject({ expected: 'Page title cart page contains the test data value "email"', actual: 'The test data value "email" was not provided' });
  });

  it("builds expected / actual from templates", () => {
    expect(run(match("contains", "confirmed"), { values: { title: "Order confirmed" } })).toMatchObject({
      expected: 'Page title cart page contains "confirmed"',
      actual: 'Page title cart page is "Order confirmed"',
    });
    expect(run(match("regex", "^Order", true), { values: { title: "Order" } }).expected).toBe(
      "Page title cart page matches /^Order/ (case-sensitive)",
    );
  });
});

describe("visible", () => {
  it("true/false against expected", () => {
    expect(verify({ kind: "visible", fact: banner, expected: true }, { banner: true })).toBe("PASS");
    expect(verify({ kind: "visible", fact: banner, expected: true }, { banner: false })).toBe("FAIL");
    expect(verify({ kind: "visible", fact: banner, expected: false }, { banner: false })).toBe("PASS");
    expect(verify({ kind: "visible", fact: banner, expected: false }, { banner: true })).toBe("FAIL");
  });

  it("builds expected / actual from templates; a non-boolean value is not observed", () => {
    expect(run({ kind: "visible", fact: banner, expected: false }, { values: { banner: true } })).toMatchObject({
      status: "FAIL",
      expected: "Error banner cart page is not visible",
      actual: "Error banner cart page is visible",
    });
    expect(statusOf(run({ kind: "visible", fact: banner, expected: true }, { values: { banner: null } }))).toEqual([
      "INCONCLUSIVE",
      "FACT_NOT_OBSERVED",
    ]);
  });

  it.each(["yes", "no", "true", "false", 1, 0] as const)("only a boolean counts: %j → INCONCLUSIVE / FACT_NOT_OBSERVED, never FAIL", (value) => {
    for (const expected of [true, false]) {
      expect(statusOf(run({ kind: "visible", fact: banner, expected }, { values: { banner: value } }))).toEqual([
        "INCONCLUSIVE",
        "FACT_NOT_OBSERVED",
      ]);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Step 1: missing facts, stop reasons, policy blocks
// ---------------------------------------------------------------------------------------------

describe("required fact missing → INCONCLUSIVE, never FAIL", () => {
  const rule = { kind: "numeric_compare", left: after, operator: "gt", right: before } as const;
  const { steps } = cartExploration();
  const upToBefore = steps.slice(0, 2);

  it("exploration completed but the fact was not recorded → FACT_NOT_OBSERVED", () => {
    const r = run(rule, { values: { before: 0 } });
    expect(statusOf(r)).toEqual(["INCONCLUSIVE", "FACT_NOT_OBSERVED"]);
    expect(r.actual).toBe("Not observed: Cart count after add");
    expect(r.factRefs).toEqual([after, before]);
  });

  it.each(["STEP_LIMIT_REACHED", "EXPLORATION_BUDGET_EXHAUSTED"] as const)("exploration stopped early (%s) → that reason", (stopReason) => {
    expect(statusOf(run(rule, { values: { before: 0 }, steps: upToBefore, stopReason }))).toEqual(["INCONCLUSIVE", stopReason]);
  });

  it("COMPLETED after a trailing FAILED step (R25) → FACT_NOT_OBSERVED", () => {
    const failed = [...upToBefore, step(2, "PS-3", "act", { outcome: "FAILED", error: "no element" }), step(3, "PS-3", "act", { outcome: "FAILED", error: "no element" })];
    const r = run(rule, { values: { before: 0 }, steps: failed, stopReason: "COMPLETED" });
    expect(statusOf(r)).toEqual(["INCONCLUSIVE", "FACT_NOT_OBSERVED"]);
    expect(r.actual).toBe("Not observed: Cart count after add (exploration stopped after PS-3 failed)");
  });

  it("a criterion whose facts were all captured is still decided when exploration stopped early", () => {
    const early = { kind: "numeric_compare", left: before, operator: "eq", right: 0 } as const;
    expect(verify(early, { before: 0 })).toBe("PASS");
    expect(run(early, { values: { before: 0 }, steps: upToBefore, stopReason: "STEP_LIMIT_REACHED" }).status).toBe("PASS");
  });
});

describe("checkpoint unreachable because a step was BLOCKED_BY_POLICY", () => {
  const rule = { kind: "numeric_compare", left: after, operator: "gt", right: before } as const;
  const { steps } = cartExploration();

  it.each(["DESTRUCTIVE_ACTION_NOT_AUTHORIZED", "MISSING_SECRET", "MISSING_TEST_DATA", "OFF_DOMAIN_NAVIGATION"] as const)(
    "→ BLOCKED with the step's reason (%s)",
    (blockReason) => {
      const blockedSteps = [...steps.slice(0, 2), step(2, "PS-3", "act", { outcome: "BLOCKED_BY_POLICY", blockReason })];
      const r = run(rule, { values: { before: 0 }, steps: blockedSteps, stopReason: "BLOCKED_BY_POLICY" });
      expect(statusOf(r)).toEqual(["BLOCKED", blockReason]);
      expect(r.actual).toBe(`Exploration was blocked by policy at PS-3 (${blockReason}) before Cart count after add was observed`);
    },
  );

  it("a blocked step without a reason → TARGET_BLOCKED_BY_POLICY", () => {
    const blockedSteps = [...steps.slice(0, 2), step(2, "PS-3", "navigate", { outcome: "BLOCKED_BY_POLICY", blockReason: null })];
    expect(statusOf(run(rule, { values: { before: 0 }, steps: blockedSteps, stopReason: "BLOCKED_BY_POLICY" }))).toEqual([
      "BLOCKED",
      "TARGET_BLOCKED_BY_POLICY",
    ]);
  });

  it("criteria whose checkpoints were captured before the block are still decided", () => {
    const blockedSteps = [...steps.slice(0, 2), step(2, "PS-3", "act", { outcome: "BLOCKED_BY_POLICY", blockReason: "DESTRUCTIVE_ACTION_NOT_AUTHORIZED" })];
    const early = { kind: "numeric_compare", left: before, operator: "eq", right: 0 } as const;
    expect(run(early, { values: { before: 0 }, steps: blockedSteps, stopReason: "BLOCKED_BY_POLICY" }).status).toBe("PASS");
  });
});

// ---------------------------------------------------------------------------------------------
// Step 1: plan blocks, preconditions, login
// ---------------------------------------------------------------------------------------------

describe("criterion in plan.blockedCriteria", () => {
  const rule = { kind: "numeric_compare", left: after, operator: "gt", right: before } as const;
  const blocked: BlockedCriterion[] = [{ criterionId: "AC-1", reason: "MISSING_SECRET", detail: 'Secret "password" was not provided (used by PS-2)' }];

  it("→ BLOCKED with that reason and detail, even when facts would pass", () => {
    const r = run(rule, { values: { before: 0, after: 1 }, plan: planOf(cartPlan.scenarios[0]!.steps, blocked) });
    expect(r).toMatchObject({ status: "BLOCKED", reason: "MISSING_SECRET", actual: 'Secret "password" was not provided (used by PS-2)' });
  });

  it("the all-blocked path: no facts, no steps", () => {
    const r = run(rule, { facts: [], steps: [], stopReason: "COMPLETED", plan: planOf(cartPlan.scenarios[0]!.steps, blocked) });
    expect(statusOf(r)).toEqual(["BLOCKED", "MISSING_SECRET"]);
  });

  it("wins over a semantic outcome and an unmet precondition", () => {
    const r = run(
      { kind: "semantic", description: "The page looks trustworthy" },
      { plan: planOf(cartPlan.scenarios[0]!.steps, blocked), criterion: { preconditions: [{ kind: "authenticated", description: "logged in" }] } },
    );
    expect(statusOf(r)).toEqual(["BLOCKED", "MISSING_SECRET"]);
  });

  it("only blocks the named criterion", () => {
    const other: BlockedCriterion[] = [{ criterionId: "AC-2", reason: "MISSING_SECRET", detail: "x" }];
    expect(run(rule, { values: { before: 0, after: 1 }, plan: planOf(cartPlan.scenarios[0]!.steps, other) }).status).toBe("PASS");
  });
});

describe("precondition `authenticated`", () => {
  const rule = { kind: "numeric_compare", left: after, operator: "gt", right: before } as const;
  const authenticated = { preconditions: [{ kind: "authenticated" as const, description: "The user is logged in" }] };

  it("with no login step in the plan → BLOCKED / PRECONDITION_NOT_MET", () => {
    const r = run(rule, { values: { before: 0, after: 1 }, criterion: authenticated });
    expect(statusOf(r)).toEqual(["BLOCKED", "PRECONDITION_NOT_MET"]);
    expect(r.actual).toBe("The plan has no login step for the precondition: The user is logged in");
  });

  it("with a login step in the plan → evaluated", () => {
    const plan = planOf([planned("PS-1", "navigate"), planned("PS-7", "login"), ...cartPlan.scenarios[0]!.steps.slice(1)]);
    expect(run(rule, { values: { before: 0, after: 1 }, criterion: authenticated, plan }).status).toBe("PASS");
  });

  it("other precondition kinds do not need a login step", () => {
    const r = run(rule, { values: { before: 0, after: 1 }, criterion: { preconditions: [{ kind: "secret", ref: "password", description: "a password" }] } });
    expect(r.status).toBe("PASS");
  });
});

describe("login failed (R15)", () => {
  const LOGIN = "https://shop.example.com/login";
  const ACCOUNT = "https://shop.example.com/account";
  const loginPlan = planOf([
    planned("PS-1", "navigate"),
    planned("PS-2", "capture_checkpoint", { checkpoint: "login_page" }),
    planned("PS-3", "fill", { inputRef: { source: "testData", key: "username" } }),
    planned("PS-4", "fill", { inputRef: { source: "secret", key: "password" } }),
    planned("PS-5", "login"),
    planned("PS-6", "capture_checkpoint", { checkpoint: "account" }),
  ]);
  const greeting = { key: "greeting", checkpoint: "account" } as const;
  const loginTitle = { key: "heading", checkpoint: "login_page" } as const;
  const afterLogin = { kind: "text_matches", fact: greeting, match: { mode: "contains", value: "Welcome", caseSensitive: false } } as const;
  const beforeLogin = { kind: "text_matches", fact: loginTitle, match: { mode: "contains", value: "Sign in", caseSensitive: false } } as const;

  /** A login flow: `loginStep` overrides the golden act of PS-5; `accountUrl` is the url fact at `account`. */
  function loginRun(rule: ExpectedOutcome, o: { loginStep?: Partial<ExplorationStep>; accountUrl?: string | null; failedLogin?: boolean }) {
    const s = [
      step(0, "PS-1", "navigate", { urlBefore: "about:blank", urlAfter: LOGIN }),
      step(1, "PS-2", "checkpoint", { urlBefore: LOGIN, urlAfter: LOGIN }),
      step(2, "PS-3", "fill", { urlBefore: LOGIN, urlAfter: LOGIN }),
      step(3, "PS-4", "fill", { urlBefore: LOGIN, urlAfter: LOGIN }),
      step(4, "PS-5", "observe", { urlBefore: LOGIN, urlAfter: LOGIN, onGoldenPath: false }),
    ];
    const facts = [fact({ key: "url", checkpoint: "login_page" }, LOGIN, s[1]!.id), fact(loginTitle, "Sign in", s[1]!.id)];
    if (o.failedLogin) {
      s.push(step(5, "PS-5", "act", { urlBefore: LOGIN, urlAfter: LOGIN, outcome: "FAILED", error: "timeout" }));
      s.push(step(6, "PS-5", "act", { urlBefore: LOGIN, urlAfter: LOGIN, outcome: "FAILED", error: "timeout" }));
    } else {
      s.push(step(5, "PS-5", "act", { urlBefore: LOGIN, urlAfter: ACCOUNT, ...o.loginStep }));
      if (o.accountUrl !== null) {
        const cp = step(6, "PS-6", "checkpoint", { urlBefore: o.accountUrl ?? ACCOUNT, urlAfter: o.accountUrl ?? ACCOUNT });
        s.push(cp);
        facts.push(fact({ key: "url", checkpoint: "account" }, o.accountUrl ?? ACCOUNT, cp.id), fact(greeting, "Welcome back, Ada", cp.id));
      }
    }
    return run(rule, { facts, steps: s, plan: loginPlan, stopReason: "COMPLETED" });
  }

  it("login SUCCESS and the page moved on → evaluated", () => {
    expect(loginRun(afterLogin, {}).status).toBe("PASS");
  });

  it("login SUCCESS but the next checkpoint still shows the login page (same origin+path) → BLOCKED / LOGIN_FAILED", () => {
    const r = loginRun(afterLogin, { accountUrl: `${LOGIN}?error=invalid` });
    expect(statusOf(r)).toEqual(["BLOCKED", "LOGIN_FAILED"]);
    expect(r.actual).toBe("Login step PS-5 succeeded but the page stayed at https://shop.example.com/login");
  });

  it("the next url fact wins over urlAfter (redirected back to the login form)", () => {
    expect(statusOf(loginRun(afterLogin, { loginStep: { urlAfter: ACCOUNT }, accountUrl: LOGIN }))).toEqual(["BLOCKED", "LOGIN_FAILED"]);
  });

  it("no checkpoint after the login step: urlAfter decides", () => {
    expect(statusOf(loginRun(afterLogin, { loginStep: { urlAfter: `${LOGIN}/` }, accountUrl: null }))).toEqual(["BLOCKED", "LOGIN_FAILED"]);
    // Moved on, but the account checkpoint was never captured: an ordinary missing fact.
    expect(statusOf(loginRun(afterLogin, { loginStep: { urlAfter: ACCOUNT }, accountUrl: null }))).toEqual(["INCONCLUSIVE", "FACT_NOT_OBSERVED"]);
  });

  it("criteria whose checkpoints come before the login step are evaluated normally", () => {
    expect(loginRun(beforeLogin, { accountUrl: LOGIN }).status).toBe("PASS");
  });

  it("a FAILED (not SUCCESS) login step is not LOGIN_FAILED (R25) → FACT_NOT_OBSERVED", () => {
    expect(statusOf(loginRun(afterLogin, { failedLogin: true }))).toEqual(["INCONCLUSIVE", "FACT_NOT_OBSERVED"]);
  });
});

// ---------------------------------------------------------------------------------------------
// Step 1: semantic outcomes
// ---------------------------------------------------------------------------------------------

describe("semantic outcome", () => {
  const semantic = { kind: "semantic", description: "The checkout page looks trustworthy" } as const;
  const ambiguity = { reason: "“trustworthy” is subjective", suggestions: ["Name a visible trust badge"] };

  it("→ INCONCLUSIVE / AI_JUDGED_ONLY, no fact refs", () => {
    const r = run(semantic, { values: { title: "Checkout" } });
    expect(r).toMatchObject({ status: "INCONCLUSIVE", reason: "AI_JUDGED_ONLY", factRefs: [], expected: semantic.description, actual: null });
  });

  it("with non-null ambiguity → INCONCLUSIVE / AMBIGUOUS_CRITERION", () => {
    expect(statusOf(run(semantic, { criterion: { ambiguity } }))).toEqual(["INCONCLUSIVE", "AMBIGUOUS_CRITERION"]);
  });

  it("ambiguity on a deterministic outcome does not change its evaluation", () => {
    const rule = { kind: "numeric_compare", left: after, operator: "gt", right: before } as const;
    expect(run(rule, { values: { before: 0, after: 1 }, criterion: { ambiguity } }).status).toBe("PASS");
  });
});

// ---------------------------------------------------------------------------------------------
// Provenance and output bounds
// ---------------------------------------------------------------------------------------------

describe("provenance and output", () => {
  const rule = { kind: "numeric_compare", left: after, operator: "gt", right: before } as const;

  it("provenance does not change the provisional status (reconciliation does)", () => {
    expect(run(rule, { values: { before: 0, after: 1 }, provenance: "MODEL_EXTRACTED" }).status).toBe("PASS");
    expect(run(rule, { values: { before: 1, after: 1 }, provenance: "MODEL_EXTRACTED" }).status).toBe("FAIL");
  });

  it("expected / actual stay within 1000 characters for huge values", () => {
    const long = Array.from({ length: 500 }, (_, i) => `Product number ${i} with a long name`);
    const r = run({ kind: "collection_contains", collection: items, item: "x".repeat(400), match: "contains" }, { values: { items: long } });
    expect(r.status).toBe("FAIL");
    expect(r.actual!.length).toBeLessThanOrEqual(1000);
    expect(r.expected.length).toBeLessThanOrEqual(1000);
  });

  it("is pure: the same input gives the same result and inputs are not mutated", () => {
    const { steps, checkpointStep } = cartExploration();
    const facts = [fact(before, 0, checkpointStep.before_add!.id), fact(after, 1, checkpointStep.after_add!.id)];
    const input = { criterion: criterion(rule), facts, blocked: [], steps, stopReason: "COMPLETED" as const, plan: cartPlan };
    const snapshot = JSON.stringify(input);
    expect(verifyCriterion(input)).toEqual(verifyCriterion(input));
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe("verifyStage and test data values (KI-001)", () => {
  it("judges a text check against the run's value for its test data key", async () => {
    const { verifyStage } = await import("./verify-stage");
    const keyed = { kind: "text_matches" as const, fact: { key: "accountEmail", checkpoint: "account_page" }, match: { mode: "contains" as const, testDataKey: "email", caseSensitive: false } };
    const requirement: NormalizedRequirement = {
      runId: "run_1",
      revision: 1,
      originalText: "The account page shows the user's email.",
      criteria: [{ ...criterion(keyed), id: "AC-1", sourceText: "The account page shows the user's email." }],
      facts: [{ key: "accountEmail", checkpoint: "account_page", description: "Signed-in email", valueType: "string" }],
      confirmedAt: "2026-10-05T10:00:00.000Z",
    };
    const plan: TestPlan = {
      runId: "run_1",
      requirementRevision: 1,
      scenarios: [{ id: "SC-1", title: "a", criterionIds: ["AC-1"], steps: [{ id: "PS-1", kind: "capture_checkpoint", description: "Capture", checkpoint: "account_page", criterionIds: ["AC-1"], destructive: false }] }],
      blockedCriteria: [],
      stopConditions: [],
    };
    const shown = (value: string): ObservedFact => ({ key: "accountEmail", checkpoint: "account_page", value, provenance: "DOM_VERIFIED", read: { element: { candidates: [{ strategy: "testId", value: "e" }], chosenIndex: 0, framePath: [] }, mode: "text" }, stepId: "s1" });
    const judge = (testData: Record<string, string>, value: string) =>
      verifyStage({ redact: (v: unknown) => v, request: { testData } } as unknown as Parameters<typeof verifyStage>[0], requirement, plan, { steps: [], facts: [shown(value)], stopReason: "COMPLETED" })[0]!;
    expect(judge({ email: "qa@demo.test" }, "Signed in as qa@demo.test")).toMatchObject({ status: "PASS", expected: 'Account email account page contains "qa@demo.test"' });
    expect(judge({ email: "qa@demo.test" }, "Signed in as other@demo.test")).toMatchObject({ status: "FAIL" });
    expect(judge({}, "Signed in as qa@demo.test")).toMatchObject({ status: "BLOCKED", reason: "MISSING_TEST_DATA" });

    // 2026-10-07: a value nobody provided that a fill generated is the run's value for its key.
    const generatedFill = step(0, null, "fill", { inputRef: { source: "testData", key: "email" }, generatedValue: "gen.user@example.com" });
    const withGenerated = (value: string) =>
      verifyStage({ redact: (v: unknown) => v, request: { testData: {} } } as unknown as Parameters<typeof verifyStage>[0], requirement, plan, { steps: [generatedFill], facts: [shown(value)], stopReason: "COMPLETED" })[0]!;
    expect(withGenerated("Signed in as gen.user@example.com")).toMatchObject({ status: "PASS", expected: 'Account email account page contains "gen.user@example.com"' });
    expect(withGenerated("Signed in as qa@demo.test")).toMatchObject({ status: "FAIL" });
  });
});

describe("verifyStage with several scenarios (V1.1 F9)", () => {
  it("judges each criterion on its own scenario's stop reason and steps", async () => {
    const { verifyStage } = await import("./verify-stage");
    const shown = (key: string, checkpoint: string) => ({ kind: "visible" as const, fact: { key, checkpoint }, expected: true });
    const requirement: NormalizedRequirement = {
      runId: "run_1",
      revision: 1,
      originalText: "The banner shows. The orders show.",
      criteria: [
        { ...criterion(shown("banner", "home")), id: "AC-1", sourceText: "The banner shows." },
        { ...criterion(shown("orders", "orders_page")), id: "AC-2", sourceText: "The orders show." },
      ],
      facts: [
        { key: "banner", checkpoint: "home", description: "Banner", valueType: "boolean" },
        { key: "orders", checkpoint: "orders_page", description: "Orders", valueType: "boolean" },
      ],
      confirmedAt: "2026-09-29T10:00:00.000Z",
    };
    const plan: TestPlan = {
      runId: "run_1",
      requirementRevision: 1,
      scenarios: [
        { id: "SC-1", title: "a", criterionIds: ["AC-1"], steps: [{ id: "PS-1", kind: "capture_checkpoint", description: "Capture home", checkpoint: "home", criterionIds: ["AC-1"], destructive: false }] },
        { id: "SC-2", title: "b", criterionIds: ["AC-2"], steps: [{ id: "PS-2", kind: "capture_checkpoint", description: "Capture orders", checkpoint: "orders_page", criterionIds: ["AC-2"], destructive: false }] },
      ],
      blockedCriteria: [],
      stopConditions: [],
    };
    const bannerFact: ObservedFact = { key: "banner", checkpoint: "home", value: true, provenance: "DOM_VERIFIED", read: { element: { candidates: [{ strategy: "testId", value: "b" }], chosenIndex: 0, framePath: [] }, mode: "visible" }, stepId: "s1" };
    const ctx = { redact: (v: unknown) => v, request: { testData: {} } } as unknown as Parameters<typeof verifyStage>[0];
    const results = verifyStage(ctx, requirement, plan, {
      steps: [],
      facts: [bannerFact],
      stopReason: "BLOCKED_BY_POLICY",
      scenarioStops: { "SC-1": "COMPLETED", "SC-2": "EXPLORATION_BUDGET_EXHAUSTED" },
    });
    expect(results.map((r) => [r.criterionId, r.status, r.reason])).toEqual([
      ["AC-1", "PASS", null],
      ["AC-2", "INCONCLUSIVE", "EXPLORATION_BUDGET_EXHAUSTED"],
    ]);
  });
});
