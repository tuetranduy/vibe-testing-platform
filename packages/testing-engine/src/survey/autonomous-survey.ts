import {
  DiscoveryFixtureUrlSchema,
  SuggestionSchema,
  type DiscoveryCandidate,
  type Suggestion,
  type SuggestionSetDraft,
} from "@platform/contracts";
import { assertActionAllowed } from "@platform/security";
import type { AutonomousDiscoveryPort } from "../discovery/port";
import type { EngineStages, StageContext } from "../orchestrator/stages";

const MAX_DISCOVERY_MS = 120_000;
// Leave time for the existing orchestrator to save and publish the suggestions after a timeout.
const SURVEY_COMPLETION_MS = 5_000;
const MAX_SUGGESTIONS = 8;
const PRESERVED_SURVEY_COUNT = 2;

export interface AutonomousSurveyDeps {
  fixtureUrl: string;
  port: AutonomousDiscoveryPort;
  logger?: { warn(obj: object, message: string): void };
}

function fingerprint(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function toSuggestion(candidate: DiscoveryCandidate, ctx: StageContext): Suggestion | null {
  const [firstExpected, ...additionalExpected] = candidate.expectedBehavior;
  const essential = `${candidate.goal}\nExpected behavior\n${firstExpected}`;
  const context = [
    ...additionalExpected,
    `Relevant pages\n${candidate.relevantPaths.join(", ")}`,
    ...candidate.negativeCases.map((text) => `Negative case\n${text}`),
  ];
  let requirement = essential;
  for (const detail of context) {
    if (requirement.length + detail.length + 2 <= 1000) requirement += `\n\n${detail}`;
  }
  const instruction = [candidate.title, candidate.goal, candidate.rationale, ...candidate.expectedBehavior, ...candidate.negativeCases].join("\n");
  if (!assertActionAllowed({ instruction }, { allowDestructive: false }).allowed) return null;

  const parsed = SuggestionSchema.safeParse(ctx.redact({
    id: "S-1",
    title: candidate.title,
    requirement,
    why: candidate.rationale,
    needs: { secrets: [], testData: [] },
    destructive: false,
  }));
  return parsed.success ? parsed.data : null;
}

function mergeSurveySuggestions(
  draft: SuggestionSetDraft,
  candidates: DiscoveryCandidate[],
  ctx: StageContext,
): SuggestionSetDraft {
  const titles = new Set(draft.suggestions.map((suggestion) => fingerprint(suggestion.title)));
  const goals = new Set(draft.suggestions.map((suggestion) => fingerprint(suggestion.requirement)));
  const added: Suggestion[] = [];
  // Prefer candidates supported by multiple distinct fixture pages; ties preserve provider order.
  const ranked = candidates
    .map((candidate) => ({ candidate, depth: new Set(candidate.relevantPaths).size }))
    .sort((a, b) => b.depth - a.depth);
  const limit = MAX_SUGGESTIONS - Math.min(PRESERVED_SURVEY_COUNT, draft.suggestions.length);
  for (const { candidate } of ranked) {
    if (added.length === limit) break;
    const suggestion = toSuggestion(candidate, ctx);
    if (!suggestion) continue;
    const title = fingerprint(suggestion.title);
    const goal = fingerprint(candidate.goal);
    if (titles.has(title) || goals.has(goal)) continue;
    titles.add(title);
    goals.add(goal);
    added.push(suggestion);
  }
  if (added.length === 0) return draft;
  const suggestions = [
    ...draft.suggestions.slice(0, PRESERVED_SURVEY_COUNT),
    ...added,
    ...draft.suggestions.slice(PRESERVED_SURVEY_COUNT),
  ].slice(0, MAX_SUGGESTIONS).map((suggestion, index): Suggestion => ({ ...suggestion, id: `S-${index + 1}` }));
  return { ...draft, suggestions };
}

/** Enrich only the real survey for the operator's disposable staging fixture. */
export function withAutonomousDiscovery(
  survey: EngineStages["survey"],
  discovery?: AutonomousSurveyDeps,
): EngineStages["survey"] {
  if (!discovery) return survey;
  return async (ctx) => {
    const draft = await survey(ctx);
    if (ctx.request.environment !== "staging") return draft;
    const target = DiscoveryFixtureUrlSchema.safeParse(ctx.request.targetUrl);
    if (!target.success || target.data !== discovery.fixtureUrl) return draft;

    await ctx.boundary();
    const remaining = ctx.deadlineAt ? ctx.deadlineAt.getTime() - ctx.now().getTime() - SURVEY_COMPLETION_MS : MAX_DISCOVERY_MS;
    if (remaining <= 0) return draft;
    const signal = ctx.budgetSignal(Math.min(remaining, MAX_DISCOVERY_MS));
    try {
      const result = await discovery.port.discover(
        { schemaVersion: "discovery.v1", runId: ctx.runId, targetUrl: target.data },
        { signal },
      );
      signal.throwIfAborted();
      if (result.status === "COMPLETED") return mergeSurveySuggestions(draft, result.candidates, ctx);
      discovery.logger?.warn({ runId: ctx.runId, status: result.status }, "Browser Use discovery used the survey fallback");
    } catch {
      ctx.signal.throwIfAborted();
      discovery.logger?.warn({ runId: ctx.runId }, "Browser Use discovery used the survey fallback");
    }
    return draft;
  };
}
