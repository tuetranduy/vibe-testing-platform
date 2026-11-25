import {
  DiscoveryRouteSchema,
  MAX_DISCOVERY_ROUTES,
  type DiscoveryCandidate,
  type DiscoveryRoute,
  type RequirementDiscovery,
  type SitePage,
} from "@platform/contracts";
import { assertActionAllowed } from "@platform/security";
import { runDiscoveryJob, type AutonomousSurveyDeps, type DiscoverySnapshot } from "../discovery/run-job";
import type { StageContext } from "../orchestrator/stages";

const STOP_WORDS = new Set([
  "that", "this", "with", "from", "have", "should", "must", "when", "then", "they", "their", "there", "into", "page", "user",
  "users", "able", "will", "each", "after", "before", "which", "what", "also", "only", "shows", "show", "click", "open",
  "test", "tests", "verify", "check", "checks", "visitor", "website", "site",
  // Verbs that say how a result is seen, not what the requirement is about.
  "list", "lists", "listed", "displays", "displayed", "appears", "appear", "works", "work", "contains", "includes", "updates",
]);

const words = (text: string): Set<string> =>
  new Set((text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []).filter((w) => !STOP_WORDS.has(w)));

const fingerprint = (text: string) => text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** How many of the requirement's content words a candidate shares (prefix matches count: "cart" ~ "carts"). */
function relevance(requirement: ReadonlySet<string>, candidate: DiscoveryCandidate): number {
  const hay = words([candidate.title, candidate.goal, ...candidate.expectedBehavior, ...candidate.relevantPaths.join(" ").split(/[/_.-]+/)].join(" "));
  let score = 0;
  for (const w of requirement) if (hay.has(w) || [...hay].some((h) => h.startsWith(w) || w.startsWith(h))) score++;
  return score;
}

/**
 * Browser Use candidates → the routes the analysis may use for an explicit requirement: read-only, related to the
 * requirement by at least one content word, distinct, ranked by relevance then by how many pages they span, and at
 * most four. Everything else is dropped, so an unrelated idea never reaches the criteria.
 */
export function routesForRequirement(candidates: readonly DiscoveryCandidate[], requirement: string): DiscoveryRoute[] {
  const wanted = words(requirement);
  const seen = new Set<string>();
  const ranked = candidates
    .map((candidate, order) => ({ candidate, order, score: relevance(wanted, candidate), depth: new Set(candidate.relevantPaths).size }))
    .filter(({ candidate, score }) => score > 0 && assertActionAllowed({
      instruction: [candidate.title, candidate.goal, ...candidate.expectedBehavior].join("\n"),
    }, { allowDestructive: false }).allowed)
    .sort((a, b) => b.score - a.score || b.depth - a.depth || a.order - b.order);
  const routes: DiscoveryRoute[] = [];
  for (const { candidate } of ranked) {
    if (routes.length === MAX_DISCOVERY_ROUTES) break;
    const key = fingerprint(candidate.goal);
    if (seen.has(key)) continue;
    const parsed = DiscoveryRouteSchema.safeParse({
      title: candidate.title,
      goal: candidate.goal,
      relevantPaths: [...new Set(candidate.relevantPaths)],
      expectedBehavior: candidate.expectedBehavior.slice(0, 3),
    });
    if (!parsed.success) continue;
    seen.add(key);
    routes.push(parsed.data);
  }
  return routes;
}

/** The requirement as the agent may see it: redacted, one line, bounded. Null when too short to focus on. */
export function discoveryFocus(ctx: Pick<StageContext, "redact" | "request">): string | undefined {
  const requirement = String(ctx.redact(ctx.request.requirement));
  const oneLine = (text: string) => text.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
  let text = oneLine(requirement);
  if (text.length > 1000) {
    const checkpoints = requirement.split(/\r?\n/).filter((line) => /^\s*Then\s+/i.test(line)).map(oneLine);
    const outcomes = checkpoints.length > 0 ? ` Expected checkpoints: ${checkpoints.join(" ")}`.slice(0, 450) : "";
    text = `${text.slice(0, 1000 - outcomes.length).trimEnd()}${outcomes}`;
  }
  return text.length >= 10 ? text : undefined;
}

/**
 * Phase C, exploration-time recovery: routes Browser Use finds for one planned step, from a quiet job (up to 90 s,
 * its own broker job id). The run's quota, rollout flag and fair admission apply; no discovery
 * event is published, so the run's discovery outcome stays the survey's or the analysis'. Live-site runs use the
 * real site when live interaction is on; a snapshot-only live-site run gets none (its snapshot is not kept).
 */
export async function discoverStepRoutes(ctx: StageContext, discovery: AutonomousSurveyDeps | undefined, goal: string): Promise<DiscoveryRoute[]> {
  const { autonomousDiscovery, verifiedSiteDiscovery, discoveryLiveInteraction, discoveryMaxSeconds } = ctx.request.options;
  const verified = verifiedSiteDiscovery === true;
  const live = verified && discoveryLiveInteraction === true && discovery?.liveInteraction === true;
  if (!autonomousDiscovery || (verified && !live)) return [];
  const focus = `Find where a visitor can do this step and the pages on the way: ${goal}`.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").slice(0, 1000);
  const { value } = await runDiscoveryJob(ctx, discovery, {
    verified, live, focus, quiet: true, jobId: "r1",
    maxSeconds: Math.min(90, discoveryMaxSeconds ?? 90),
    fallbackLabel: "Exploration continues without it.",
    accept: (candidates) => {
      const routes = routesForRequirement(candidates, goal);
      return { value: routes, acceptedCount: routes.length };
    },
  });
  return value ?? [];
}

export interface RequirementDiscoveryResult {
  discovery: RequirementDiscovery;
  /** Live-site mode: the pages the snapshot was read from, for the analysis in place of a browser read. */
  pages: SitePage[];
}

/**
 * Phase B: an opted-in explicit-requirement run asks Browser Use for routes that exercise its requirement. Never
 * fails the analysis: every outcome other than cancellation and the hard deadline is recorded (one
 * `discovery.completed` / `discovery.failed` event) and the analysis goes on with whatever routes there are.
 */
export async function discoverRequirementRoutes(
  ctx: StageContext,
  discovery: AutonomousSurveyDeps | undefined,
): Promise<RequirementDiscoveryResult> {
  const verified = ctx.request.options.verifiedSiteDiscovery === true;
  let pages: SitePage[] = [];
  let snapshot: DiscoverySnapshot | undefined;
  if (verified && discovery?.readVerifiedSite && discovery.port && discovery.fixtureUrl) {
    try {
      ({ pages, snapshot } = await discovery.readVerifiedSite(ctx));
    } catch (error) {
      ctx.signal.throwIfAborted();
      discovery.logger?.warn({ runId: ctx.runId, err: error instanceof Error ? error.message : String(error) },
        "The live site could not be read for requirement discovery");
      const summary = { status: "BLOCKED" as const, reason: "target_not_allowed" as const, attempted: false,
        candidateCount: 0, acceptedCount: 0, pageCount: 0, fallbackUsed: true };
      discovery.observe?.(summary, null);
      await ctx.publish({ type: "discovery.failed", message: "Browser Use could not read this site. Analyzing the requirement without it.", payload: summary });
      return { discovery: { summary, routes: [] }, pages };
    }
  }
  const focus = discoveryFocus(ctx);
  const { value, summary } = await runDiscoveryJob(ctx, verified && !discovery?.readVerifiedSite ? { ...discovery, port: undefined } : discovery, {
    verified,
    live: verified && ctx.request.options.discoveryLiveInteraction === true && discovery?.liveInteraction === true,
    agents: ctx.request.options.discoveryAgents ?? 1,
    areas: pages.slice(1).map(({ url, inventory }) => ({ path: new URL(url).pathname, title: inventory.title })),
    ...(snapshot && { snapshot }),
    ...(focus && { focus }),
    fallbackLabel: "Analyzing the requirement without it.",
    accept: (candidates) => {
      const routes = routesForRequirement(candidates, ctx.request.requirement);
      return { value: routes, acceptedCount: routes.length };
    },
  });
  return { discovery: { summary, routes: value ?? [] }, pages };
}
