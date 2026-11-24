import type { DiscoveryRoute } from "@platform/contracts";
import { assertActionAllowed } from "@platform/security";
import { isAllowedPageHost } from "../survey/links";

/**
 * Phase C, agent-assisted recovery (plan §3.2, BU-024): Browser Use only *recommends* a page. The executor turns the
 * recommendation into an ordinary, policy-checked `navigate` on the run's own guarded session, then Stagehand
 * locates and acts on the planned step there as it always does. No agent-authored action or code is replayed.
 */

const STOP = new Set([
  "click", "button", "link", "page", "open", "select", "enter", "type", "fill", "field", "with", "from", "that", "this",
  "into", "onto", "then", "the", "and", "for", "your", "visible", "shown", "step", "should",
]);
const words = (text: string) =>
  new Set((text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((w) => !STOP.has(w)));

function overlap(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let score = 0;
  for (const w of a) if (b.has(w) || [...b].some((h) => h.length >= 4 && w.length >= 4 && (h.startsWith(w) || w.startsWith(h)))) score++;
  return score;
}

/**
 * The one route page to try for a step whose control was not found: a page of the best-matching route (by the
 * step's words against the route's text and the path's own words), on the run's allowed hosts, not the page the
 * browser is on, and not one whose path reads as a destructive action. Null when no route shares a word with the
 * step: a route never redirects an unrelated step.
 */
export function chooseRouteUrl(
  routes: readonly DiscoveryRoute[],
  stepDescription: string,
  where: { current: string; targetUrl: string; additionalAllowedHosts: readonly string[] },
): string | null {
  const step = words(stepDescription);
  if (step.size === 0) return null;
  const start = new URL(where.targetUrl);
  let current: string | null = null;
  try {
    const at = new URL(where.current);
    current = `${at.origin}${at.pathname}`;
  } catch {
    // not a URL yet (about:blank): every route page is elsewhere
  }
  let best: { url: string; score: number } | null = null;
  for (const route of routes) {
    const routeScore = overlap(step, words([route.title, route.goal, ...route.expectedBehavior].join(" ")));
    for (const path of route.relevantPaths) {
      let url: URL;
      try {
        url = new URL(path, start.origin);
      } catch {
        continue;
      }
      if (`${url.origin}${url.pathname}` === current) continue;
      if (!/^https?:$/.test(url.protocol) || !isAllowedPageHost(url, start, [...where.additionalAllowedHosts])) continue;
      const pathWords = words(url.pathname.replace(/[/_.-]+/g, " "));
      if (!assertActionAllowed({ instruction: [...pathWords].join(" ") || "open page" }, { allowDestructive: false }).allowed) continue;
      // The path's own words count double: they say which page of the route holds the step's control.
      const score = routeScore + 2 * overlap(step, pathWords);
      if (score > 0 && (!best || score > best.score)) best = { url: url.href, score };
    }
  }
  return best?.url ?? null;
}
