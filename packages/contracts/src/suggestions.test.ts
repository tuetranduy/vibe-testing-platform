import { describe, expect, it } from "vitest";
import {
  CancelReasonSchema,
  CreateTestRunRequestSchema,
  RunLifecycleSchema,
  SelectSuggestionRequestSchema,
  SuggestionSchema,
  SuggestionSetResponseSchema,
  SuggestionSetSchema,
  TEST_EVENT_TYPES,
  TestEventSchema,
  type Suggestion,
} from "./index";

const suggestion = (patch: Partial<Suggestion> = {}): Suggestion => ({
  id: "S-1",
  title: "Add a product to the cart",
  requirement: "A user can add iPhone 17 Pro to the cart from its product page.",
  why: "Product pages have an Add to cart button.",
  needs: { secrets: [], testData: [] },
  destructive: false,
  ...patch,
});
const page = { url: "https://shop.example.com/", title: "Home", status: "READ" as const };
const set = (patch: Record<string, unknown> = {}) => ({ suggestions: [suggestion()], pages: [page], selected: null, ...patch });

describe("the requirement is optional", () => {
  const base = { targetUrl: "https://shop.example.com" };

  it.each([
    ["omitted", {}],
    ["empty", { requirement: "" }],
    ["whitespace only", { requirement: "  \n  " }],
  ])("%s → an empty requirement (the run explores the website and suggests tests)", (_name, extra) => {
    expect(CreateTestRunRequestSchema.parse({ ...base, ...extra }).requirement).toBe("");
  });

  it.each(["x", "123456789", "  12345678  "])("1–9 characters (%j) → one issue at requirement", (requirement) => {
    const r = CreateTestRunRequestSchema.safeParse({ ...base, requirement });
    expect(r.success).toBe(false);
    expect(r.error?.issues).toEqual([
      expect.objectContaining({
        path: ["requirement"],
        message: "Describe the requirement in at least 10 characters, or leave it empty for suggestions.",
      }),
    ]);
  });

  it("10 characters or more (after trimming) is a requirement", () => {
    expect(CreateTestRunRequestSchema.parse({ ...base, requirement: "  1234567890  " }).requirement).toBe("1234567890");
  });

  it("stays at most 20,000 characters", () => {
    expect(CreateTestRunRequestSchema.safeParse({ ...base, requirement: "x".repeat(20_001) }).success).toBe(false);
  });
});

describe("lifecycle and cancel reason", () => {
  it("SURVEYING and AWAITING_SELECTION sit between QUEUED and ANALYZING_REQUIREMENT (the web orders stages by it)", () => {
    expect(RunLifecycleSchema.options.slice(0, 4)).toEqual(["QUEUED", "SURVEYING", "AWAITING_SELECTION", "ANALYZING_REQUIREMENT"]);
  });

  it("a run can be cancelled because no suggested test was chosen in time", () => {
    expect(CancelReasonSchema.options).toEqual(["USER_REQUESTED", "CONFIRMATION_EXPIRED", "SELECTION_EXPIRED"]);
  });
});

describe("SuggestionSchema", () => {
  it("accepts a well-formed suggestion", () => {
    expect(SuggestionSchema.safeParse(suggestion({ needs: { secrets: ["password"], testData: ["email"] } })).success).toBe(true);
  });

  it.each([
    ["an id past S-8", { id: "S-9" }],
    ["an id of another shape", { id: "AC-1" }],
    ["a 2-character title", { title: "ab" }],
    ["an 81-character title", { title: "t".repeat(81) }],
    ["a 9-character requirement", { requirement: "too short" }],
    ["a 1001-character requirement", { requirement: "r".repeat(1001) }],
    ["a 301-character why", { why: "w".repeat(301) }],
    ["6 secrets", { needs: { secrets: ["a", "b", "c", "d", "e", "f"], testData: [] } }],
    ["a secret name no run could have", { needs: { secrets: ["Password"], testData: [] } }],
    ["11 test data keys", { needs: { secrets: [], testData: Array.from({ length: 11 }, (_, i) => `k${i}`) } }],
    ["a test data key that is not a key", { needs: { secrets: [], testData: ["1 bad"] } }],
  ])("rejects %s", (_name, patch) => {
    expect(SuggestionSchema.safeParse(suggestion(patch as Partial<Suggestion>)).success).toBe(false);
  });
});

describe("SuggestionSetSchema", () => {
  it("accepts 1 to 8 suggestions and up to 6 pages, nothing selected yet", () => {
    const eight = Array.from({ length: 8 }, (_, i) => suggestion({ id: `S-${i + 1}` }));
    expect(SuggestionSetSchema.safeParse(set({ suggestions: eight, pages: Array(6).fill(page) })).success).toBe(true);
  });

  it.each([
    ["no suggestion", { suggestions: [] }],
    ["9 suggestions", { suggestions: Array.from({ length: 9 }, (_, i) => suggestion({ id: `S-${(i % 8) + 1}` })) }],
    ["7 pages", { pages: Array(7).fill(page) }],
    ["a page that is not an http(s) URL", { pages: [{ ...page, url: "javascript:alert(1)" }] }],
    ["a page status other than READ / SKIPPED", { pages: [{ ...page, status: "FAILED" }] }],
    ["duplicate ids", { suggestions: [suggestion(), suggestion({ title: "Another test" })] }],
    ["a selection of a suggestion that is not in the set", { selected: { suggestionId: "S-2", edited: false } }],
  ])("rejects %s", (_name, patch) => {
    expect(SuggestionSetSchema.safeParse(set(patch)).success).toBe(false);
  });

  it("records which suggestion was chosen and whether its text was edited", () => {
    expect(SuggestionSetSchema.parse(set({ selected: { suggestionId: "S-1", edited: true } })).selected).toEqual({
      suggestionId: "S-1",
      edited: true,
    });
  });

  it("the GET response adds what the run has, so the UI can mark unmet needs", () => {
    const r = SuggestionSetResponseSchema.parse({
      ...set(),
      run: { secretNames: ["password"], testDataKeys: ["email"], destructiveActionsAllowed: false },
    });
    expect(r.run).toEqual({ secretNames: ["password"], testDataKeys: ["email"], destructiveActionsAllowed: false });
  });
});

describe("SelectSuggestionRequestSchema", () => {
  it("takes a suggestion id and, optionally, the edited text (trimmed)", () => {
    expect(SelectSuggestionRequestSchema.parse({ suggestionId: "S-2" })).toEqual({ suggestionId: "S-2" });
    expect(SelectSuggestionRequestSchema.parse({ suggestionId: "S-2", requirement: "  Search lists matching products.  " }).requirement).toBe(
      "Search lists matching products.",
    );
  });

  it.each([
    ["an id of another shape", { suggestionId: "suggestion-1" }],
    ["a 9-character text", { suggestionId: "S-1", requirement: "too short" }],
    ["a 20,001-character text", { suggestionId: "S-1", requirement: "x".repeat(20_001) }],
  ])("rejects %s", (_name, body) => {
    expect(SelectSuggestionRequestSchema.safeParse(body).success).toBe(false);
  });
});

const envelope = {
  id: "evt_1",
  runId: "run_1",
  sequence: 1,
  timestamp: "2026-09-28T10:00:00.000Z",
  stage: "SURVEYING",
  message: "Loaded /cart — Your cart",
};

describe("survey events", () => {
  it("page.surveyed carries a path, never a query string or a fragment", () => {
    const ok = { ...envelope, type: "page.surveyed", payload: { path: "/cart", title: "Your cart", status: "READ" } };
    expect(TestEventSchema.safeParse(ok).success).toBe(true);
    for (const path of ["/reset?email=alice@example.com", "/cart#items"]) {
      expect(TestEventSchema.safeParse({ ...ok, payload: { ...ok.payload, path } }).success).toBe(false);
    }
    expect(TestEventSchema.safeParse({ ...ok, payload: { ...ok.payload, status: "FAILED" } }).success).toBe(false);
  });

  it("suggestions.proposed carries ids and titles only, never a suggestion's text", () => {
    const e = TestEventSchema.parse({
      ...envelope,
      type: "suggestions.proposed",
      message: "1 test suggested",
      payload: { count: 1, suggestions: [{ id: "S-1", title: "Add to cart", requirement: "A user can add a product.", why: "…" }] },
    });
    expect(e.payload).toEqual({ count: 1, suggestions: [{ id: "S-1", title: "Add to cart" }] });
  });

  it("suggestion.selected carries the id and whether the text was edited, never the text", () => {
    const e = TestEventSchema.parse({
      ...envelope,
      stage: "AWAITING_SELECTION",
      type: "suggestion.selected",
      message: "Suggestion S-1 selected",
      payload: { suggestionId: "S-1", edited: true, requirement: "the edited text" },
    });
    expect(e.payload).toEqual({ suggestionId: "S-1", edited: true });
  });

  it("the event list gains the three survey events", () => {
    expect(TEST_EVENT_TYPES).toEqual(expect.arrayContaining(["page.surveyed", "suggestions.proposed", "suggestion.selected"]));
  });
});
