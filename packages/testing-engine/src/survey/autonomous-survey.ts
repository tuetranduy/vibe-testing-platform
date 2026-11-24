import {
  BrowserProviderError,
  SuggestionSchema,
  type DiscoveryCandidate,
  type DiscoveryInput,
  type Suggestion,
  type SuggestionSetDraft,
} from "@platform/contracts";
import { assertActionAllowed } from "@platform/security";
import { runDiscoveryJob, type AutonomousSurveyDeps } from "../discovery/run-job";
import type { EngineStages, StageContext } from "../orchestrator/stages";

export {
  classifyDiscoveryResult, DISCOVERY_RESULT_GRACE_S,
  type AutonomousSurveyDeps, type DiscoveryAdmission, type DiscoveryAdmissionRequest,
} from "../discovery/run-job";

const MAX_SUGGESTIONS = 8;
const PRESERVED_SURVEY_COUNT = 2;

function fingerprint(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function toSuggestion(candidate: DiscoveryCandidate, ctx: StageContext): Suggestion | null {
  // Each selected suggestion becomes one runnable scenario. Fixture paths are kept in its provenance.
  const requirement = `${candidate.goal}\nExpected behavior\n${candidate.expectedBehavior[0]}`;
  const instruction = [candidate.title, candidate.goal, candidate.rationale, ...candidate.expectedBehavior, ...candidate.negativeCases].join("\n");
  if (!assertActionAllowed({ instruction }, { allowDestructive: false }).allowed) return null;

  const parsed = SuggestionSchema.safeParse(ctx.redact({
    id: "S-1",
    title: candidate.title,
    requirement,
    why: candidate.rationale,
    needs: { secrets: [], testData: [] },
    destructive: false,
    discovery: { engine: "browser_use", relevantPaths: [...new Set(candidate.relevantPaths)] },
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

/**
 * Enrich only the real survey for the operator's disposable staging fixture. A run that did not opt in gets the
 * survey unchanged and no discovery events. An opted-in run always records one typed outcome (`discovery.completed`
 * or `discovery.failed`), including when this worker cannot run discovery at all.
 */
export function withAutonomousDiscovery(
  survey: EngineStages["survey"],
  discovery?: AutonomousSurveyDeps,
): EngineStages["survey"] {
  return async (ctx) => {
    const options = ctx.request.options;
    const verified = options.verifiedSiteDiscovery === true;
    let draft: SuggestionSetDraft;
    let snapshot: DiscoveryInput["snapshot"];
    if (verified) {
      if (!discovery?.prepareVerifiedSite || !discovery.port || !discovery.fixtureUrl) {
        throw new BrowserProviderError("Verified site discovery is unavailable on this worker");
      }
      if (discovery.reserve && !(await discovery.reserve(ctx.tenantId))) {
        throw new BrowserProviderError("This tenant has reached its hourly discovery limit");
      }
      ({ draft, snapshot } = await discovery.prepareVerifiedSite(ctx));
    } else {
      draft = await survey(ctx);
    }
    if (!options.autonomousDiscovery) return draft;

    const { value } = await runDiscoveryJob(ctx, discovery, {
      verified,
      reserved: verified,
      // Live interaction when the run asks for it and this worker's broker offers it; else the offline snapshot.
      live: verified && options.discoveryLiveInteraction === true && discovery?.liveInteraction === true,
      // Extra agents each take one of the pages the standard survey read, past the start page.
      agents: options.discoveryAgents ?? 1,
      areas: draft.pages.filter((p) => p.status === "READ").slice(1).map((p) => ({ path: new URL(p.url).pathname, title: p.title })),
      ...(snapshot && { snapshot }),
      fallbackLabel: "Showing standard survey suggestions.",
      accept: (candidates) => {
        const merged = mergeSurveySuggestions(draft, candidates, ctx);
        return { value: merged, acceptedCount: merged.suggestions.filter((suggestion) => suggestion.discovery).length };
      },
    });
    return value ?? draft;
  };
}
