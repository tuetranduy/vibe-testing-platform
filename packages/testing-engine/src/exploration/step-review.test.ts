import { FakeTransport, LlmClient, LlmTransportError } from "@platform/llm";
import { createRunRedactor } from "@platform/security";
import { describe, expect, it } from "vitest";
import { createStepReviewer, type StepReviewInput } from "./step-review";

const input = (signal = new AbortController().signal): StepReviewInput => ({
  requirement: "Check out the cart",
  done: [],
  step: { id: "PS-1", kind: "click", description: "Click Checkout", criterionIds: [], destructive: false },
  remaining: [],
  page: { url: "https://shop.test/cart", title: "Cart", screenshot: null, html: "<button>Checkout</button>", dialogs: [], network: [] },
  runId: "run_1",
  signal,
  redact: createRunRedactor(),
});

const reviewer = (transport: FakeTransport) =>
  createStepReviewer(new LlmClient({ transport, model: "claude-sonnet-5", sleep: async () => {}, retry: { maxRetries: 0, baseDelayMs: 1 } }))!;

describe("createStepReviewer", () => {
  it("none without a model", () => {
    expect(createStepReviewer(null)).toBeNull();
  });

  it("returns the model's review", async () => {
    const transport = new FakeTransport().enqueue({ json: { verdict: "off_track", observation: "A terms dialog is open", reason: "Checkout was refused" } });
    await expect(reviewer(transport).review(input())).resolves.toMatchObject({ verdict: "off_track" });
  });

  it("reviews the visible section summary and requires section-specific Continue progress (2026-11-22, KI-087)", async () => {
    const transport = new FakeTransport().enqueue({ json: { verdict: "off_track", observation: "Shipping Address is open", reason: "Shipping Method has not been reached" } });
    const request = input();
    request.step.description = "Click Continue in the Shipping Method section";
    request.page.locationSummary = 'Where the page is:\nVisible headings (in order): ["Shipping Address"]\nOpen/current steps or sections: ["Shipping Address"]';
    await reviewer(transport).review(request);
    const sent = transport.requests[0]!;
    const content = sent.messages[0]!.content;
    expect(Array.isArray(content)).toBe(true);
    expect(content[1]).toMatchObject({ type: "text", text: expect.stringContaining(request.page.locationSummary) });
    expect(sent.system).toContain("Judge only from the screenshot and visible page context");
    expect(sent.system).toContain("or the next section/page for Continue/Next");
    expect(sent.system).toContain('return "off_track" and name the section actually shown');
  });

  it("a failed review is no review: it never fails the run (the review only advises)", async () => {
    const transport = new FakeTransport().enqueue({ error: new LlmTransportError("The model stopped without an answer (length)", { retryable: false }) });
    await expect(reviewer(transport).review(input())).resolves.toBeNull();
  });

  it("cancellation still ends the run", async () => {
    const abort = new AbortController();
    abort.abort(new Error("cancelled"));
    await expect(reviewer(new FakeTransport().enqueue({ json: {} })).review(input(abort.signal))).rejects.toThrow();
  });
});
