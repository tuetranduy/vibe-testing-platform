import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

type ReviewIdea = { fixture: string; title: string; requirement: string; source: "survey" | "discovery" };
const ideaText = z.object({ fixture: z.string(), title: z.string(), requirement: z.string() });
const rating = ideaText.extend({
  id: z.uuid(),
  useful: z.boolean().nullable(),
  scenario: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,79}$/).nullable(),
}).refine(({ useful, scenario }) => (useful === true) === (scenario !== null), "Give each useful idea a scenario ID");
const ratingSheet = z.object({ evaluationId: z.uuid(), ideas: z.array(rating) });
const reviewReport = z.object({
  kind: z.literal("hosted-model-fixture-evaluation"),
  expectedFixtures: z.number().int().positive(),
  review: z.object({
    evaluationId: z.uuid(),
    candidates: z.array(z.object({ id: z.uuid(), digest: z.string(), source: z.enum(["survey", "discovery"]) })),
  }),
  rows: z.array(z.object({
    fixture: z.string(), returned: z.number().int().nonnegative(), offered: z.number().int().nonnegative(),
    modelCostUsd: z.number().nonnegative().nullable(),
    addedMs: z.number().nonnegative(), discoveryCompleted: z.boolean(), playwrightOraclePassed: z.boolean(),
  }).refine(({ returned, offered }) => offered <= returned, "Offered ideas cannot exceed returned ideas")),
});

function ideaDigest({ fixture, title, requirement }: z.input<typeof ideaText>): string {
  return createHash("sha256").update(JSON.stringify([fixture, title, requirement])).digest("hex");
}

/** Give the reviewer a mixed list with opaque IDs. Source labels stay with the machine report. */
export function prepareReview(ideas: ReviewIdea[]) {
  const evaluationId = randomUUID();
  const entries = ideas.map((idea) => ({ ...idea, id: randomUUID() })).sort((a, b) => a.id.localeCompare(b.id));
  return {
    review: { evaluationId, candidates: entries.map((idea) => ({ id: idea.id, source: idea.source, digest: ideaDigest(idea) })) },
    sheet: { evaluationId, ideas: entries.map(({ id, fixture, title, requirement }) => ({
      id, fixture, title, requirement, useful: null, scenario: null,
    })) },
  };
}

/** Score a complete set of fixture runs, including fixtures where the hosted model falls back. */
export function scoreReview(rawReport: unknown, rawSheet: unknown) {
  const { rows, expectedFixtures, review } = reviewReport.parse(rawReport);
  const { evaluationId, ideas } = ratingSheet.parse(rawSheet);
  if (evaluationId !== review.evaluationId) throw new Error("The ratings and results are from different evaluations");
  if (rows.length !== expectedFixtures || new Set(rows.map(({ fixture }) => fixture)).size !== expectedFixtures ||
      rows.some(({ playwrightOraclePassed }) => !playwrightOraclePassed)) {
    throw new Error("Every fixture must have a result and a passing independent fixture check");
  }
  const candidates = new Map(review.candidates.map((candidate) => [candidate.id, candidate]));
  const ratings = new Map(ideas.map((idea) => [idea.id, idea]));
  if (candidates.size !== review.candidates.length || ratings.size !== ideas.length || candidates.size !== ratings.size) {
    throw new Error("Expected one rating entry for each original candidate ID");
  }
  const useful = { survey: new Set<string>(), discovery: new Set<string>() };
  const fixtures = new Map(rows.map(({ fixture }) => [fixture, 0]));
  let rated = 0;
  for (const [id, candidate] of candidates) {
    const idea = ratings.get(id);
    if (!idea || ideaDigest(idea) !== candidate.digest || !fixtures.has(idea.fixture)) {
      throw new Error("Rating entries must retain their original ID, fixture and text");
    }
    if (candidate.source === "discovery") fixtures.set(idea.fixture, fixtures.get(idea.fixture)! + 1);
    if (idea.useful !== null) rated++;
    if (idea.useful) useful[candidate.source].add(`${idea.fixture}\0${idea.scenario}`);
  }
  if (rows.some(({ fixture, offered }) => offered !== fixtures.get(fixture))) {
    throw new Error("The review sheet does not account for every offered discovery idea");
  }

  const offered = rows.reduce((total, row) => total + row.offered, 0);
  const returned = rows.reduce((total, row) => total + row.returned, 0);
  const reviewComplete = rated === ideas.length;
  const novel = new Set([...useful.discovery].filter((scenario) => !useful.survey.has(scenario)));
  const usefulDiscoveryRate = reviewComplete && returned > 0 ? useful.discovery.size / returned : null;
  const newCoverageYield = reviewComplete && useful.survey.size > 0 ? novel.size / useful.survey.size : null;
  const pricedFixtures = rows.filter((row) => row.modelCostUsd !== null).length;
  const totalCost = pricedFixtures === expectedFixtures ? rows.reduce((total, row) => total + row.modelCostUsd!, 0) : null;
  const latency = rows.map(({ addedMs }) => addedMs).sort((a, b) => a - b);
  return {
    evaluationId,
    fixtures: expectedFixtures,
    discoveryCompleted: rows.filter(({ discoveryCompleted }) => discoveryCompleted).length,
    reviewComplete,
    rated,
    reviewEntries: ideas.length,
    discoveryIdeasReturned: returned,
    discoveryIdeasOffered: offered,
    distinctUsefulSurveyScenarios: reviewComplete ? useful.survey.size : null,
    distinctUsefulDiscoveryScenarios: reviewComplete ? useful.discovery.size : null,
    novelUsefulDiscoveryScenarios: reviewComplete ? novel.size : null,
    usefulDiscoveryRate,
    usefulDiscoveryTargetMet: usefulDiscoveryRate === null ? null : usefulDiscoveryRate >= 0.7,
    newCoverageYield,
    newCoverageTargetMet: newCoverageYield === null ? null : newCoverageYield >= 0.25,
    pricedFixtures,
    estimatedDiscoveryModelCostUsd: totalCost,
    estimatedDiscoveryModelCostPerUsefulCandidateUsd: reviewComplete && useful.discovery.size > 0 && totalCost !== null
      ? totalCost / useful.discovery.size : null,
    addedLatencyMs: { p50: latency[Math.ceil(latency.length * 0.5) - 1], p95: latency[Math.ceil(latency.length * 0.95) - 1] },
  };
}
