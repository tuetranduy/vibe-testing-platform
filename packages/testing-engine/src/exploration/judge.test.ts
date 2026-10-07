import { FakeTransport, LlmClient, type FakeReply } from "@platform/llm";
import { createRunRedactor } from "@platform/security";
import { describe, expect, it } from "vitest";
import { buildJudgePrompt, createCriterionJudge, type JudgeRequest } from "./judge";

const request = (over: Partial<JudgeRequest> = {}): JudgeRequest => ({
  requirement: "Open the shop; the home page should look professional.",
  criterion: {
    id: "AC-1",
    statement: "The home page looks professional",
    sourceText: "the home page should look professional",
    expectedOutcome: { kind: "semantic", description: "The home page looks professional" },
    ambiguity: { reason: "“professional” is subjective", suggestions: [] },
  },
  stepDescription: "Open the home page",
  url: "https://shop.test/",
  inventory: { title: "Demo Shop", description: "", headings: [{ level: 1, text: "Welcome" }], links: [], forms: [], buttons: ["Shop now"] },
  text: "Welcome\nShop now",
  screenshot: Buffer.from("png"),
  runId: "run_1",
  signal: new AbortController().signal,
  redact: createRunRedactor(),
  ...over,
});

function setup(...replies: FakeReply[]) {
  const transport = new FakeTransport().enqueue(...replies);
  const llm = new LlmClient({ transport, model: "claude-sonnet-5", sleep: async () => {} });
  return { transport, llm };
}

describe("createCriterionJudge", () => {
  it("sends the requirement, the criterion, the page scan and the screenshot; returns the judgment and the usage", async () => {
    const { llm, transport } = setup({
      json: { relevant: true, verdict: "holds", observed: "A clean layout with a 'Welcome' heading", reasoning: "Read as: tidy and consistent" },
      usage: { inputTokens: 900, outputTokens: 60 },
    });
    const out = await createCriterionJudge(llm)!.judge(request());
    expect(out).toEqual({
      judgment: { relevant: true, verdict: "HOLDS", observed: "A clean layout with a 'Welcome' heading", reasoning: "Read as: tidy and consistent" },
      llm: { model: "claude-sonnet-5", inputTokens: 900, outputTokens: 60, cacheHit: null },
    });
    const sent = transport.requests[0]!;
    expect(sent.schemaName).toBe("judge_criterion");
    const content = sent.messages[0]!.content as { type: string; text?: string; mimeType?: string }[];
    expect(content.map((p) => p.type)).toEqual(["text", "image"]);
    expect(content[0]!.text).toContain("the home page should look professional");
    expect(content[0]!.text).toContain("“professional” is subjective");
    expect(content[0]!.text).toContain("Shop now");
    expect(content[0]!.text).toContain("What the test just did: Open the home page");
  });

  it("a page that does not show the criterion never decides it", async () => {
    // The model answers "not relevant" but still a verdict: corrected once, and kept as CANNOT_TELL either way.
    const { llm, transport } = setup(
      { json: { relevant: false, verdict: "holds", observed: "A login form", reasoning: "-" } },
      { json: { relevant: false, verdict: "cannot_tell", observed: "A login form", reasoning: "-" } },
    );
    const out = await createCriterionJudge(llm)!.judge(request());
    expect(out.judgment).toMatchObject({ relevant: false, verdict: "CANNOT_TELL" });
    expect(transport.requests).toHaveLength(2);
  });

  it("without a model (the fake engine) there is no judge; without a screenshot the prompt says so", () => {
    expect(createCriterionJudge(null)).toBeNull();
    expect(buildJudgePrompt(request(), false)).toContain("No screenshot could be taken.");
    expect(buildJudgePrompt(request({ inventory: null, text: "" }), true)).toContain("(could not be read)");
  });
});
