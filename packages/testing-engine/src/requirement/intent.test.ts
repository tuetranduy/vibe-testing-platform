import { describe, expect, it } from "vitest";
import { LEFT_OUT, WHOLE_REQUIREMENT_NOTE, groundInferred, salvage, wholeRequirementFallback } from "./intent";
import type { CompilerOutput } from "./model-output";

type Criterion = CompilerOutput["criteria"][number];
type Clarity = NonNullable<CompilerOutput["intent"]>["clarity"];

const TEXT = "Test the search";

/** Criterion n reads the boolean fact `shown<n>` at checkpoint `cp_<n>` (unless `fact` names another). */
const criterion = (n: number, over: Partial<Criterion> & { fact?: string } = {}): Criterion => {
  const { fact, ...rest } = over;
  return {
    sourceText: TEXT,
    statement: `Check number ${n} holds`,
    expectedOutcome: { kind: "visible", fact: { key: fact ?? `shown${n}`, checkpoint: `cp_${fact ? 1 : n}` }, expected: true },
    preconditions: [],
    ambiguity: null,
    ...rest,
  };
};
const inferred = (n: number, over: Partial<Criterion> & { fact?: string } = {}) =>
  criterion(n, { origin: "inferred", rationale: `Reason ${n}`, ...over });

function out(criteria: Criterion[], opts: { clarity?: Clarity | null; checks?: Record<number, "found" | "not_found" | "unclear"> } = {}): CompilerOutput {
  const keys = new Set<string>();
  const facts: CompilerOutput["facts"] = [];
  for (const c of criteria) {
    if (c.expectedOutcome.kind !== "visible") continue;
    const { key, checkpoint } = c.expectedOutcome.fact;
    if (keys.has(`${key}@${checkpoint}`)) continue;
    keys.add(`${key}@${checkpoint}`);
    facts.push({ key, checkpoint, description: `Whether ${key} is shown`, valueType: "boolean" });
  }
  const checks = opts.checks ?? Object.fromEntries(criteria.map((_c, i) => [i + 1, "found" as const]));
  return {
    title: "Search",
    intent: opts.clarity === null ? null : { clarity: opts.clarity ?? "feature", goal: "A visitor can search the shop", feature: "Search" },
    criteria,
    facts,
    siteChecks: Object.entries(checks).map(([n, status]) => ({ criterion: Number(n), status, note: `Note ${n}` })),
    testData: [],
  };
}

const ctx = { pagesRead: true, secretNames: [] as string[] };
const statements = (o: CompilerOutput) => o.criteria.map((c) => c.statement);

describe("groundInferred", () => {
  it("keeps inferred criteria the pages show, for a requirement that is not specific", () => {
    const o = out([criterion(1), inferred(2), inferred(3)]);
    expect(groundInferred(o, ctx)).toEqual({ output: o, notes: [] });
  });

  it("drops them for a specific requirement, and when the model gave no intent", () => {
    for (const clarity of ["specific", null] as const) {
      const r = groundInferred(out([criterion(1), inferred(2)], { clarity }), ctx);
      expect(statements(r.output)).toEqual(["Check number 1 holds"]);
      expect(r.notes).toEqual([LEFT_OUT("Check number 2 holds", "the requirement already says what to check")]);
    }
  });

  it("drops them when no pages of the site were read", () => {
    const r = groundInferred(out([criterion(1), inferred(2)]), { ...ctx, pagesRead: false });
    expect(statements(r.output)).toEqual(["Check number 1 holds"]);
    expect(r.notes).toEqual([LEFT_OUT("Check number 2 holds", "no pages of the site were read")]);
  });

  it("drops one whose site check is missing, not found or unclear", () => {
    for (const checks of [{ 1: "found" }, { 1: "found", 2: "not_found" }, { 1: "found", 2: "unclear" }] as Record<number, "found" | "not_found" | "unclear">[]) {
      const r = groundInferred(out([criterion(1), inferred(2)], { checks }), ctx);
      expect(statements(r.output)).toEqual(["Check number 1 holds"]);
      expect(r.notes).toEqual([LEFT_OUT("Check number 2 holds", "the pages read do not show it")]);
    }
  });

  it("drops one that would change or delete data", () => {
    const r = groundInferred(out([criterion(1), inferred(2, { statement: "Delete the account and confirm it is gone" })]), ctx);
    expect(statements(r.output)).toEqual(["Check number 1 holds"]);
    expect(r.notes).toEqual([LEFT_OUT("Delete the account and confirm it is gone", "it would change or delete data")]);
  });

  it("drops one that needs a credential the run does not have, and keeps it when the run has it", () => {
    const withSecret = inferred(2, { preconditions: [{ kind: "secret", ref: "password", description: "The account password" }] });
    const r = groundInferred(out([criterion(1), withSecret]), ctx);
    expect(r.notes).toEqual([LEFT_OUT("Check number 2 holds", "it needs a credential the run does not have")]);
    expect(groundInferred(out([criterion(1), withSecret]), { ...ctx, secretNames: ["password"] }).notes).toEqual([]);
  });

  it("keeps the first 5 and drops the rest", () => {
    const r = groundInferred(out([criterion(1), ...[2, 3, 4, 5, 6, 7, 8].map((n) => inferred(n))]), ctx);
    expect(r.output.criteria).toHaveLength(6);
    expect(r.notes).toEqual([7, 8].map((n) => LEFT_OUT(`Check number ${n} holds`, "more than 5 checks were added")));
  });

  it("never drops a stated criterion, whatever its site check", () => {
    const o = out([criterion(1), criterion(2)], { clarity: "specific", checks: { 1: "not_found" } });
    expect(groundInferred(o, { ...ctx, pagesRead: false })).toEqual({ output: o, notes: [] });
  });

  it("renumbers the site checks of the criteria that follow a dropped one", () => {
    const r = groundInferred(out([criterion(1), inferred(2), criterion(3)], { checks: { 1: "found", 2: "unclear", 3: "not_found" } }), ctx);
    expect(statements(r.output)).toEqual(["Check number 1 holds", "Check number 3 holds"]);
    expect(r.output.siteChecks).toEqual([
      { criterion: 1, status: "found", note: "Note 1" },
      { criterion: 2, status: "not_found", note: "Note 3" },
    ]);
  });

  it("keeps a fact a remaining criterion reads and removes one only the dropped criterion read", () => {
    const shared = inferred(2, { fact: "shown1" });
    const r = groundInferred(out([criterion(1), shared, inferred(3)], { checks: { 1: "found" } }), ctx);
    expect(statements(r.output)).toEqual(["Check number 1 holds"]);
    expect(r.output.facts.map((f) => f.key)).toEqual(["shown1"]);
  });

  it("can leave no criteria at all (the compiler then judges the requirement as a whole)", () => {
    const r = groundInferred(out([inferred(1), inferred(2)], { clarity: "specific" }), ctx);
    expect(r.output.criteria).toEqual([]);
    expect(r.output.facts).toEqual([]);
    expect(r.notes).toHaveLength(2);
  });
});

describe("salvage", () => {
  const o = out([criterion(1), criterion(2), criterion(3)]);

  it("drops the criteria the issues point at and says so", () => {
    const r = salvage(o, ["criteria.1.expectedOutcome.fact: Fact x@y is not declared"]);
    expect(r && statements(r.output)).toEqual(["Check number 1 holds", "Check number 3 holds"]);
    expect(r?.output.facts.map((f) => f.key)).toEqual(["shown1", "shown3"]);
    expect(r?.output.siteChecks.map((c) => c.criterion)).toEqual([1, 2]);
    expect(r?.notes).toEqual([LEFT_OUT("Check number 2 holds", "could not be turned into a check")]);
  });

  it("gives up on an issue that names no criterion, and when no criterion would be left", () => {
    expect(salvage(o, ["facts.0.key: Fact key \"url\" is reserved"])).toBeNull();
    expect(salvage(o, ["criteria.0.sourceText: x", "criteria.1.sourceText: x", "criteria.2.sourceText: x"])).toBeNull();
    expect(salvage(o, ["criteria: Keep at least one critical criterion"])).toBeNull();
  });
});

describe("wholeRequirementFallback", () => {
  it("is one AI-judged criterion on the whole requirement, with no facts", () => {
    expect(wholeRequirementFallback("  Test the search \n")).toEqual({
      criteria: [
        {
          sourceText: "  Test the search \n",
          statement: "Test the search",
          expectedOutcome: { kind: "semantic", description: "Test the search" },
          preconditions: [],
          ambiguity: null,
        },
      ],
      facts: [],
    });
    expect(WHOLE_REQUIREMENT_NOTE).toMatch(/judged as a whole/);
  });

  it("words a requirement too short to describe a check", () => {
    const { criteria } = wholeRequirementFallback("ok");
    expect(criteria[0]).toMatchObject({ sourceText: "ok", statement: "The requirement holds", expectedOutcome: { kind: "semantic", description: "The requirement holds" } });
  });
});
