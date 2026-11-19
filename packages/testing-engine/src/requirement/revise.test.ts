import { NormalizedRequirementSchema, type NormalizedRequirement } from "@platform/contracts";
import { FakeTransport, LlmClient, type FakeReply } from "@platform/llm";
import { createRunRedactor } from "@platform/security";
import { describe, expect, it } from "vitest";
import { REVISE_SYSTEM_PROMPT, reviseCriterion, type ReviseCriterionInput } from "./revise";

const TEXT = "Open the Pixel 11 page. The price is shown. The product can be added to the cart.";

const requirement: NormalizedRequirement = NormalizedRequirementSchema.parse({
  runId: "run_1",
  revision: 2,
  originalText: TEXT,
  criteria: [
    {
      id: "AC-1",
      sourceText: "The price is shown.",
      statement: "The price is shown",
      expectedOutcome: { kind: "visible", fact: { key: "priceShown", checkpoint: "product_page" }, expected: true },
      preconditions: [],
      critical: true,
      ambiguity: null,
      origin: "inferred",
      rationale: "A product page shows its price",
    },
    {
      id: "AC-3",
      sourceText: "The product can be added to the cart.",
      statement: "The product can be added to the cart",
      expectedOutcome: { kind: "semantic", description: "The product can be added to the cart" },
      preconditions: [],
      critical: false,
      ambiguity: null,
    },
  ],
  facts: [{ key: "priceShown", checkpoint: "product_page", description: "Whether the price is shown", valueType: "boolean" }],
  confirmedAt: null,
});

/** The answer for "the price is in euros and under €50": a text check and a number check would be two; one is asked. */
const euroCheck = (over: Record<string, unknown> = {}) => ({
  title: null,
  intent: null,
  criteria: [
    {
      sourceText: "anything the model says",
      statement: "The price is under 50 euros",
      expectedOutcome: { kind: "numeric_compare", left: { key: "priceEur", checkpoint: "product_page" }, operator: "lt", right: 50 },
      preconditions: [],
      ambiguity: null,
      origin: "inferred",
      rationale: "The model thought so",
      ...over,
    },
  ],
  facts: [{ key: "priceEur", checkpoint: "product_page", description: "The price in euros", valueType: "number" }],
  siteChecks: [],
  testData: [],
});

function setup(...replies: FakeReply[]) {
  const transport = new FakeTransport().enqueue(...replies);
  const llm = new LlmClient({ transport, model: "claude-sonnet-5", sleep: async () => {} });
  return { transport, llm };
}

const input = (over: Partial<ReviseCriterionInput> = {}): ReviseCriterionInput => ({
  requirement,
  criterionId: "AC-1",
  instruction: "the price is shown in euros and is under €50",
  testData: {},
  secretNames: [],
  runId: "run_1",
  signal: new AbortController().signal,
  redact: createRunRedactor(),
  ...over,
});

describe("reviseCriterion (2026-11-19)", () => {
  it("replaces only that criterion: id, quote and weight kept, now the user's own; its facts swapped", async () => {
    const { llm } = setup({ json: euroCheck() });
    const out = await reviseCriterion(llm, input());
    expect(out.criteria.map((c) => c.id)).toEqual(["AC-1", "AC-3"]);
    const [revised, other] = out.criteria;
    expect(revised).toMatchObject({
      id: "AC-1",
      sourceText: "The price is shown.",
      statement: "The price is under 50 euros",
      critical: true,
      expectedOutcome: { kind: "numeric_compare", operator: "lt", right: 50 },
    });
    expect(revised).not.toHaveProperty("origin");
    expect(revised).not.toHaveProperty("rationale");
    expect(other).toEqual(requirement.criteria[1]);
    // priceShown was only the old check's: gone; priceEur added.
    expect(out.facts.map((f) => `${f.key}@${f.checkpoint}`)).toEqual(["priceEur@product_page"]);
    // A value the user wrote is theirs: not rewritten as an invented threshold.
    expect(revised!.ambiguity).toBeNull();
    expect(NormalizedRequirementSchema.safeParse({ ...requirement, criteria: out.criteria, facts: out.facts }).success).toBe(true);
  });

  it("shows the requirement, every criterion, the one to change and the user's words between markers", async () => {
    const { llm, transport } = setup({ json: euroCheck() });
    await reviseCriterion(llm, input({ testData: { productName: "Pixel 11" } }));
    const sent = transport.requests[0]!;
    expect(sent.system).toBe(REVISE_SYSTEM_PROMPT);
    expect(sent.schemaName).toBe("revised_criterion");
    const text = String(sent.messages[0]!.content);
    expect(text).toContain(`<<<REQUIREMENT\n${TEXT}\nREQUIREMENT>>>`);
    expect(text).toContain("<<<INSTRUCTION\nthe price is shown in euros and is under €50\nINSTRUCTION>>>");
    expect(text).toContain('"id":"AC-1"');
    expect(text).toContain("Criterion to rewrite: AC-1");
    expect(text).toContain("Test data keys available: productName");
  });

  it("an answer with two criteria, or a fact declared again differently, is corrected once", async () => {
    const two = euroCheck();
    two.criteria.push({ ...two.criteria[0]! });
    const clash = euroCheck({ expectedOutcome: { kind: "visible", fact: { key: "priceShown", checkpoint: "product_page" }, expected: true } });
    clash.facts = [{ key: "priceShown", checkpoint: "product_page", description: "The price is on screen", valueType: "boolean" }];
    const { llm, transport } = setup({ json: two }, { json: euroCheck() });
    expect((await reviseCriterion(llm, input())).criteria[0]!.statement).toBe("The price is under 50 euros");
    expect(transport.requests[1]!.messages.at(-1)!.content).toMatch(/exactly one criterion/);
    // Another criterion reads the clashing fact: here none does, so the old declaration is dropped and the new kept.
    const keep = setup({ json: clash });
    expect((await reviseCriterion(keep.llm, input())).facts).toEqual(clash.facts);
  });

  it("a threshold the requirement and the user never wrote is still made AI-judged", async () => {
    const { llm } = setup({ json: euroCheck() });
    const out = await reviseCriterion(llm, input({ instruction: "check the price is cheap" }));
    expect(out.criteria[0]!.expectedOutcome.kind).toBe("semantic");
  });

  it("an unknown criterion is refused before any model call", async () => {
    const { llm, transport } = setup();
    await expect(reviseCriterion(llm, input({ criterionId: "AC-9" }))).rejects.toThrow(/AC-9/);
    expect(transport.requests).toHaveLength(0);
  });
});

describe("reviseCriterion: a fact another criterion still reads", () => {
  it("declared again with another type is corrected once; reused as it is, it is kept once", async () => {
    const shared = NormalizedRequirementSchema.parse({
      ...requirement,
      criteria: [
        requirement.criteria[0],
        { ...requirement.criteria[1], expectedOutcome: { kind: "visible", fact: { key: "priceShown", checkpoint: "product_page" }, expected: true } },
      ],
    });
    const clash = euroCheck({ expectedOutcome: { kind: "visible", fact: { key: "priceShown", checkpoint: "product_page" }, expected: false } });
    clash.facts = [{ key: "priceShown", checkpoint: "product_page", description: "The price", valueType: "number" }];
    const reuse = euroCheck({ expectedOutcome: { kind: "visible", fact: { key: "priceShown", checkpoint: "product_page" }, expected: false } });
    reuse.facts = [...requirement.facts];
    const { llm, transport } = setup({ json: clash }, { json: reuse });
    const out = await reviseCriterion(llm, input({ requirement: shared }));
    expect(transport.requests[1]!.messages.at(-1)!.content).toMatch(/priceShown@product_page is declared for another criterion/);
    expect(out.facts).toEqual(requirement.facts);
    expect(out.criteria[0]!.expectedOutcome).toMatchObject({ kind: "visible", expected: false });
  });
});

describe("reviseCriterion: review findings", () => {
  it("keeps a fact no outcome reads (a URL check's checkpoint anchor) when another criterion is rewritten", async () => {
    const anchored = NormalizedRequirementSchema.parse({
      ...requirement,
      criteria: [
        requirement.criteria[0],
        { ...requirement.criteria[1], expectedOutcome: { kind: "text_matches", fact: { key: "url", checkpoint: "cart_page" }, match: { mode: "contains", value: "/cart", caseSensitive: false } } },
      ],
      facts: [...requirement.facts, { key: "cartHeading", checkpoint: "cart_page", description: "The cart page heading", valueType: "string" }],
    });
    const { llm } = setup({ json: euroCheck() });
    const out = await reviseCriterion(llm, input({ requirement: anchored }));
    expect(out.facts.map((f) => `${f.key}@${f.checkpoint}`)).toEqual(["cartHeading@cart_page", "priceEur@product_page"]);
  });

  it("a check that reads a fact of another type is corrected (a 'shown' check on a number)", async () => {
    const wrongType = euroCheck({ expectedOutcome: { kind: "visible", fact: { key: "priceEur", checkpoint: "product_page" }, expected: true } });
    const { llm, transport } = setup({ json: wrongType }, { json: euroCheck() });
    await reviseCriterion(llm, input());
    expect(transport.requests[1]!.messages.at(-1)!.content).toMatch(/priceEur@product_page is a number; a visible check reads a boolean/);
  });
});
