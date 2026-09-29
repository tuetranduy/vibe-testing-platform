import { ContractError } from "@platform/contracts";
import { FakeTransport, LlmClient, type FakeReply, type LlmCallRecord } from "@platform/llm";
import { createRunRedactor } from "@platform/security";
import { describe, expect, it } from "vitest";
import type { PageInventory } from "./inventory";
import { SURVEY_SYSTEM_PROMPT } from "./prompts";
import { suggestTests, type SuggestTestsInput } from "./suggest";

function setup(...replies: FakeReply[]) {
  const transport = new FakeTransport().enqueue(...replies);
  const records: LlmCallRecord[] = [];
  const llm = new LlmClient({ transport, model: "claude-sonnet-5", sleep: async () => {}, recordCall: (c) => void records.push(c) });
  return { transport, llm, records };
}

const inventory: PageInventory = {
  title: "Home · Demo Shop",
  description: "",
  headings: [{ level: 1, text: "Demo Shop" }],
  links: [{ text: "Cart", url: "https://shop.example.com/cart", area: "nav" }],
  forms: [],
  buttons: [],
};
const input = (patch: Partial<SuggestTestsInput> = {}): SuggestTestsInput => ({
  runId: "run_1",
  startUrl: "https://shop.example.com/",
  environment: "staging",
  destructiveAllowed: false,
  testDataKeys: ["email"],
  secretNames: ["password"],
  pages: [{ url: "https://shop.example.com/", inventory }],
  screenshot: Buffer.from("PNG-bytes"),
  signal: new AbortController().signal,
  deadlineAt: null,
  redact: (v) => v,
  ...patch,
});
const answer = (n = 3) => ({
  suggestions: Array.from({ length: n }, (_, i) => ({
    title: `Test ${i + 1}`,
    requirement: `A visitor can open page ${i + 1} and sees its heading.`,
    why: "It is linked from the home page.",
    needs: { secrets: [], testData: [] },
    destructive: false,
  })),
});
type Part = { type: string; text?: string; data?: string; mimeType?: string };
const partsOf = (t: FakeTransport, i = 0) => t.requests[i]!.messages[0]!.content as Part[];
const sent = (t: FakeTransport) => JSON.stringify(t.requests.map(({ signal: _s, ...r }) => r));

describe("suggestTests", () => {
  it("makes one SURVEYING call named test_suggestions: the survey prompt, the inventories, the start page's screenshot", async () => {
    const { llm, transport, records } = setup({ json: answer() });
    const suggestions = await suggestTests(llm, input());

    expect(suggestions.map((s) => s.id)).toEqual(["S-1", "S-2", "S-3"]);
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]!.schemaName).toBe("test_suggestions");
    expect(transport.requests[0]!.system).toBe(SURVEY_SYSTEM_PROMPT);
    const [text, image] = partsOf(transport);
    expect(text!.text).toContain("Website: https://shop.example.com/");
    expect(text!.text).toContain('"title":"Home · Demo Shop"');
    expect(image).toEqual({ type: "image", data: Buffer.from("PNG-bytes").toString("base64"), mimeType: "image/png" });
    expect(records.map((r) => [r.stage, r.runId, r.status])).toEqual([["SURVEYING", "run_1", "SUCCESS"]]);
  });

  it("sends names, never values: test data keys and secret names only, and masks secret values the pages showed", async () => {
    const secret = "pw-Very-Secret-77";
    const { llm, transport } = setup({ json: answer() });
    await suggestTests(llm, input({ pages: [{ url: "https://shop.example.com/", inventory: { ...inventory, title: `Hello ${secret}` } }], redact: createRunRedactor([secret]) }));
    const text = sent(transport);
    expect(text).toContain("Secret names available: password");
    expect(text).toContain("Test data keys available: email");
    expect(text).not.toContain(secret);
  });

  it("tells the model the environment and whether destructive actions are allowed", async () => {
    const { llm, transport } = setup({ json: answer() });
    await suggestTests(llm, input({ environment: "production", destructiveAllowed: true }));
    expect(partsOf(transport)[0]!.text).toContain("Environment: production; destructive actions are allowed in this run.");
  });

  it("without a screenshot the message is text only", async () => {
    const { llm, transport } = setup({ json: answer() });
    await suggestTests(llm, input({ screenshot: null }));
    expect(partsOf(transport).map((p) => p.type)).toEqual(["text"]);
  });

  it("asks once more when the first answer has problems, then keeps what is valid", async () => {
    const [a, b] = answer(2).suggestions;
    const first = { suggestions: [a, { ...b!, title: "x" }] };
    const corrected = { suggestions: [a, b, { ...a!, title: "A third", requirement: "short" }] };
    const { llm, transport } = setup({ json: first }, { json: corrected });

    const suggestions = await suggestTests(llm, input());

    expect(transport.requests).toHaveLength(2);
    expect(JSON.stringify(transport.requests[1]!.messages.at(-1))).toMatch(/suggestions\.1\.title/);
    expect(suggestions.map((s) => [s.id, s.title])).toEqual([
      ["S-1", "Test 1"],
      ["S-2", "Test 2"],
    ]);
  });

  it("no valid suggestion after the correction round → ContractError", async () => {
    const none = { suggestions: [{ ...answer(1).suggestions[0]!, requirement: "short" }] };
    const { llm, transport } = setup({ json: none }, { json: none });
    await expect(suggestTests(llm, input())).rejects.toBeInstanceOf(ContractError);
    expect(transport.requests).toHaveLength(2);
  });
});
