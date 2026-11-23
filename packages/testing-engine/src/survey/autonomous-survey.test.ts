import { SuggestionSetDraftSchema, type DiscoveryCandidate, type SuggestionSetDraft } from "@platform/contracts";
import { describe, expect, it, vi } from "vitest";
import type { AutonomousDiscoveryPort } from "../discovery/port";
import type { StageContext } from "../orchestrator/stages";
import { withAutonomousDiscovery } from "./autonomous-survey";

const fixtureUrl = "http://localhost:4178/";
const baseline = SuggestionSetDraftSchema.parse({
  pages: [{ url: fixtureUrl, title: "Fixture", status: "READ" }],
  suggestions: ["Open the catalog", "Use the product filter", "Read the help page"].map((title, index) => ({
    id: `S-${index + 1}`,
    title,
    requirement: `A visitor can ${title.toLowerCase()}.`,
    why: "Found in the site survey.",
    needs: { secrets: [], testData: [] },
    destructive: false,
  })),
});
const candidate = {
  title: "Navigate from category to product",
  goal: "Open a product from the category listing.",
  rationale: "The category and product pages are linked.",
  relevantPaths: ["/catalog", "/products/blue-widget"],
  expectedBehavior: ["The detail page has the selected product title."],
  negativeCases: ["An empty category has an empty-state message."],
} satisfies DiscoveryCandidate;

function context(signal = new AbortController().signal): StageContext {
  return {
    runId: "run_fixture",
    request: { targetUrl: fixtureUrl, environment: "staging", requirement: "" },
    deadlineAt: new Date("2026-11-23T00:03:00Z"),
    now: () => new Date("2026-11-23T00:00:00Z"),
    signal,
    budgetSignal: (ms: number) => AbortSignal.any([signal, AbortSignal.timeout(ms)]),
    boundary: async () => signal.throwIfAborted(),
    redact: (value: unknown) => value,
  } as StageContext;
}

const survey = async (): Promise<SuggestionSetDraft> => baseline;
const completeWith = (candidates: DiscoveryCandidate[]): AutonomousDiscoveryPort["discover"] =>
  async ({ schemaVersion, runId }) => ({ schemaVersion, runId, status: "COMPLETED", candidates });

describe("fixture discovery in the existing survey", () => {
  it("uses the original stage and result with the feature off", async () => {
    const stage = withAutonomousDiscovery(survey);
    expect(stage).toBe(survey);
    await expect(stage(context())).resolves.toBe(baseline);
  });

  it("merges useful candidates in depth order, deduplicates, and preserves two original suggestions", async () => {
    const extras = Array.from({ length: 7 }, (_, index) => ({
      ...candidate, title: `Inspect detail ${index}`, goal: `Check the product detail variant ${index}.`, relevantPaths: ["/catalog"],
    }));
    const discover = vi.fn(completeWith([
      { ...candidate, title: "OPEN THE CATALOG!" },
      ...extras,
      candidate,
      { ...candidate, title: "Delete account", goal: "Delete the customer account." },
    ]));
    const result = await withAutonomousDiscovery(survey, { fixtureUrl, port: { discover } })(context());
    expect(discover).toHaveBeenCalledWith({
      schemaVersion: "discovery.v1", runId: "run_fixture", targetUrl: fixtureUrl,
    }, { signal: expect.any(AbortSignal) });
    expect(result.pages).toBe(baseline.pages);
    expect(result.suggestions.slice(0, 2)).toEqual(baseline.suggestions.slice(0, 2));
    expect(result.suggestions[2]).toMatchObject({ title: candidate.title, why: candidate.rationale, destructive: false });
    expect(result.suggestions[2]?.requirement).toContain(candidate.expectedBehavior[0]);
    expect(result.suggestions).toHaveLength(8);
    expect(result.suggestions.map(({ title }) => title)).not.toContain("Delete account");
    expect(SuggestionSetDraftSchema.parse(result)).toEqual(result);
  });

  it.each([
    { environment: "production" },
    { targetUrl: fixtureUrl + "?token=private" },
    { targetUrl: fixtureUrl + "another-fixture" },
  ] as const)("skips runs outside the disposable fixture (%j)", async (request) => {
    const ctx = context();
    Object.assign(ctx.request, request);
    const discover = vi.fn(completeWith([candidate]));
    await expect(withAutonomousDiscovery(survey, { fixtureUrl, port: { discover } })(ctx)).resolves.toBe(baseline);
    expect(discover).not.toHaveBeenCalled();
  });

  it("returns the original suggestions if the discovery adapter fails", async () => {
    const discover = async () => { throw new Error("unavailable"); };
    await expect(withAutonomousDiscovery(survey, { fixtureUrl, port: { discover } })(context())).resolves.toBe(baseline);
  });

  it("keeps discovery under the remaining survey budget, with time for persistence", async () => {
    const ctx = context();
    ctx.deadlineAt = new Date("2026-11-23T00:00:06Z");
    const discoveryTimeout = AbortSignal.abort(new DOMException("Discovery timed out", "TimeoutError"));
    ctx.budgetSignal = vi.fn(() => discoveryTimeout);
    const discover = vi.fn(completeWith([candidate]));
    await expect(withAutonomousDiscovery(survey, { fixtureUrl, port: { discover } })(ctx)).resolves.toBe(baseline);
    expect(ctx.budgetSignal).toHaveBeenCalledWith(1000);
  });

  it("propagates an actual run cancellation", async () => {
    const controller = new AbortController();
    const error = new Error("run cancelled");
    const discover = async () => {
      controller.abort(error);
      throw new Error("launcher terminated");
    };
    await expect(withAutonomousDiscovery(survey, { fixtureUrl, port: { discover } })(context(controller.signal))).rejects.toBe(error);
  });
});
