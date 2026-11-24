import { describe, expect, it } from "vitest";
import { prepareReview, scoreReview } from "./ratings";

function evaluation() {
  const baseline = { fixture: "library", title: "Search books", requirement: "Find a book by title", source: "survey" } as const;
  const { review, sheet } = prepareReview([
    baseline,
    { ...baseline, title: "Search for a title", source: "discovery" },
    { ...baseline, title: "Follow the next page link", requirement: "Move to page two", source: "discovery" },
    { ...baseline, title: "Open page two", requirement: "Open the second page", source: "discovery" },
    { ...baseline, fixture: "museum", title: "Find a display", requirement: "Search the gallery", source: "survey" },
  ]);
  const report = {
    kind: "hosted-model-fixture-evaluation",
    expectedFixtures: 2,
    review,
    rows: [
      { fixture: "library", returned: 4, offered: 3, modelCostUsd: 0.1, addedMs: 4_200, discoveryCompleted: true, playwrightOraclePassed: true },
      { fixture: "museum", returned: 0, offered: 0, modelCostUsd: 0.2, addedMs: 8_300, discoveryCompleted: false, playwrightOraclePassed: true },
    ],
  };
  const rated = { ...sheet, ideas: sheet.ideas.map((idea) => ({
    ...idea, useful: true, scenario: idea.title.includes("page") ? "pagination" : "search",
  })) };
  return { report, sheet, rated };
}

describe("discovery evaluation ratings", () => {
  it("mixes both sources and scores distinct scenarios and new coverage separately", () => {
    const { report, rated } = evaluation();
    expect(rated.ideas.every((idea) => !("source" in idea))).toBe(true);
    const score = scoreReview(report, rated);
    expect(score).toMatchObject({
      reviewComplete: true, rated: 5, discoveryIdeasOffered: 3, discoveryIdeasReturned: 4, distinctUsefulSurveyScenarios: 2,
      distinctUsefulDiscoveryScenarios: 2, novelUsefulDiscoveryScenarios: 1, discoveryCompleted: 1,
      usefulDiscoveryRate: 0.5, usefulDiscoveryTargetMet: false, newCoverageYield: 0.5, newCoverageTargetMet: true,
      addedLatencyMs: { p50: 4_200, p95: 8_300 },
    });
    expect(score.estimatedDiscoveryModelCostUsd).toBeCloseTo(0.3);
    expect(score.estimatedDiscoveryModelCostPerUsefulCandidateUsd).toBeCloseTo(0.15);
  });

  it("withholds quality metrics until all ratings are in and never substitutes zero for unknown cost", () => {
    const { report, sheet, rated } = evaluation();
    const unpriced = { ...report, rows: report.rows.map((row) => row.fixture === "museum" ? { ...row, modelCostUsd: null } : row) };
    expect(scoreReview(unpriced, sheet)).toMatchObject({
      reviewComplete: false, rated: 0, usefulDiscoveryRate: null, newCoverageYield: null, pricedFixtures: 1,
    });
    expect(scoreReview(unpriced, rated)).toMatchObject({
      reviewComplete: true, estimatedDiscoveryModelCostUsd: null, estimatedDiscoveryModelCostPerUsefulCandidateUsd: null,
    });
  });

  it("reports zero new coverage when the model offers nothing, leaving usefulness and cost per idea undefined", () => {
    const { report, rated } = evaluation();
    const candidates = report.review.candidates.filter(({ source }) => source === "survey");
    const result = scoreReview({
      ...report, review: { ...report.review, candidates }, rows: report.rows.map((row) => ({ ...row, returned: 0, offered: 0 })),
    }, { ...rated, ideas: rated.ideas.filter(({ id }) => candidates.some((candidate) => candidate.id === id)) });
    expect(result).toMatchObject({
      discoveryIdeasOffered: 0, usefulDiscoveryRate: null, newCoverageYield: 0, newCoverageTargetMet: false,
      estimatedDiscoveryModelCostPerUsefulCandidateUsd: null,
    });
  });

  it("does not score scripted, incomplete, mismatched or edited evidence", () => {
    const { report, rated } = evaluation();
    expect(() => scoreReview({ ...report, kind: "scripted-fixture-smoke" }, rated)).toThrow();
    expect(() => scoreReview({ ...report, rows: report.rows.slice(0, 1) }, rated)).toThrow(/Every fixture/);
    expect(() => scoreReview(report, evaluation().rated)).toThrow(/different evaluations/);
    expect(() => scoreReview(report, { ...rated, ideas: rated.ideas.slice(0, -1) })).toThrow(/one rating entry/);
    rated.ideas[0]!.title = "Changed title";
    expect(() => scoreReview(report, rated)).toThrow(/original ID, fixture and text/);
  });
});
