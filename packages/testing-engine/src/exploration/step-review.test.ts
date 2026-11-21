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
