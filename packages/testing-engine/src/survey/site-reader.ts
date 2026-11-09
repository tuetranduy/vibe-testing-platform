import type { ArtifactSensitivity, SiteNetworkEntry, SitePage, SurveyedPage } from "@platform/contracts";
import type { Page, Request, Response } from "playwright-core";
import type { StageContext } from "../orchestrator/stages";
import { explorePage } from "./interactive";
import { INVENTORY_SCRIPT, parseRawInventory, toPageInventory, type RawPageInventory } from "./inventory";
import { chooseSurveyLinks, isAllowedPageHost, surveyPageUrl, surveyPath, type SurveyLink } from "./links";

/**
 * Reads a website the way the survey does (spec 2026-09-28-suggest-tests, section 5), for the survey and —
 * since V1.3 — for the requirement analysis: platform code loads the start page and a few same-site links by
 * URL (`page.goto`) and reads each with a fixed in-page script. A bounded model-guided pass also clicks
 * browsing controls and fills inputs, recording resulting inventories, screenshots and network metadata. Each page read gets a full-page screenshot (stored and announced) and
 * a `page.surveyed` event (its path, never the query).
 */

/** A run's browser for reading pages: the worker's RunSandbox, opened without the Stagehand extension. */
export interface SurveySandbox {
  page: Page;
  /** Blocked main-frame navigations (the worker's navigation guard). */
  onNavigationBlocked?(listener: (e: { url: string; reason: string }) => void): () => void;
  close(): Promise<void>;
}

export interface SurveyStore {
  saveScreenshot(input: { png: Buffer; fileName: string; sensitivity: ArtifactSensitivity }): Promise<{ artifactId: string }>;
}

export interface ReadSiteOptions {
  sandbox: SurveySandbox;
  store: SurveyStore;
  /** Page loading stops when it fires (the pages already read are kept). */
  pagesBudget: AbortSignal;
  /** Each page — loading it and reading it — gets at most this long. */
  pageTimeoutMs: number;
  /** How many linked pages to read after the start page. */
  maxLinks: number;
  /** Orders the candidate links (higher first; ties keep the survey's order). Default: the survey's order. */
  rankLinks?: (link: SurveyLink) => number;
  /** Stored screenshots are named `<prefix>-<n>.png`. */
  fileNamePrefix: string;
}

export interface SiteRead {
  /** Every page tried, in order. */
  pages: SurveyedPage[];
  /** The pages read, with what the model may see of them. */
  read: SitePage[];
  /** The latest viewport discovered from the start page (PNG), for the model; null when there is none. */
  screenshot: Buffer | null;
  /** Why the start page could not be read; null when it was. */
  startFailure: string | null;
}

type PageRead = { ok: true; url: URL; raw: RawPageInventory } | { ok: false; reason: string };

/** How long a loaded page gets for its network to go quiet before it is read (as the explorer's navigate). */
const NETWORK_QUIET_TIMEOUT_MS = 3_000;

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Settles with `work`, or rejects when `signal` fires first (the work is abandoned; closing the sandbox ends it). */
export function race<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    work.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

/** Screenshots are never secret-bearing: a run's secrets are no longer redacted (2026-10-07). */
export const screenshotSensitivity = (): ArtifactSensitivity => "STANDARD";

/**
 * Loads the start page, then up to `maxLinks` of the pages it links to (chooseSurveyLinks, ordered by
 * `rankLinks`), until `pagesBudget` fires. Never closes the sandbox (the caller owns it). Cancel and the
 * hard deadline throw the abort reason; a page that fails is recorded SKIPPED with a short reason.
 */
export async function readSite(ctx: StageContext, opts: ReadSiteOptions): Promise<SiteRead> {
  const { sandbox, store, pagesBudget, pageTimeoutMs } = opts;
  const start = new URL(ctx.request.targetUrl);
  const additional = ctx.request.options.additionalAllowedHosts;
  const sensitivity = screenshotSensitivity();

  let blocked = false;
  const unsubscribe = sandbox.onNavigationBlocked?.(() => {
    blocked = true;
  });
  const pages: SurveyedPage[] = [];
  const read: SiteRead["read"] = [];
  let screenshot: Buffer | null = null;
  const interactive = { visited: new Set<string>(), budget: { remaining: 6 } as { remaining: number; goalReached?: boolean } };
  const network: SiteNetworkEntry[] = [];
  const captureNetwork = (request: Request, status: number | null, failed: boolean) => {
    if (network.length >= 300) return;
    try {
      const url = new URL(request.url());
      if (!["http:", "https:"].includes(url.protocol)) return;
      if (!failed && !["document", "xhr", "fetch"].includes(request.resourceType())) return;
      network.push({ method: request.method().slice(0, 20), url: String(ctx.redact(surveyPageUrl(url))).slice(0, 2048),
        resourceType: request.resourceType().slice(0, 30), status, failed });
    } catch { /* Ignore malformed URLs from the page. */ }
  };
  const response = (r: Response) => captureNetwork(r.request(), r.status(), false);
  const failed = (r: Request) => captureNetwork(r, null, true);
  // Structural fake pages used by the deterministic engine need no event emitter.
  sandbox.page.on?.("response", response);
  sandbox.page.on?.("requestfailed", failed);
  let networkOffset = 0;

  /** Loads `target` by URL and reads its inventory. */
  const load = async (target: URL): Promise<PageRead> => {
    const limit = AbortSignal.any([pagesBudget, AbortSignal.timeout(pageTimeoutMs)]);
    blocked = false;
    try {
      const response = await race(sandbox.page.goto(target.href, { waitUntil: "load", timeout: pageTimeoutMs }), limit);
      const status = response?.status() ?? 200;
      if (status >= 400) return { ok: false, reason: `answered ${status}` };
      const landed = new URL(sandbox.page.url());
      if (!isAllowedPageHost(landed, start, additional)) return { ok: false, reason: "left the allowed hosts" };
      // A single-page app renders after `load` (demoqa.com/books listed no books): wait for its data, but a page
      // whose network never goes quiet (ads, polling) is read anyway.
      await race(sandbox.page.waitForLoadState("networkidle", { timeout: NETWORK_QUIET_TIMEOUT_MS }), limit).catch((err: unknown) => {
        if (limit.aborted) throw err;
      });
      const raw = parseRawInventory(await race(sandbox.page.evaluate(INVENTORY_SCRIPT), limit));
      return { ok: true, url: landed, raw };
    } catch (err) {
      if (ctx.signal.aborted) throw ctx.signal.reason;
      if (pagesBudget.aborted) return { ok: false, reason: "time budget used up" };
      if (blocked || /ERR_BLOCKED_BY_CLIENT/.test(messageOf(err))) return { ok: false, reason: "blocked by policy" };
      return { ok: false, reason: "did not load" };
    }
  };

  /** A screenshot of the current page, or null (never throws, except the abort reason). */
  const shoot = async (fullPage: boolean): Promise<Buffer | null> => {
    try {
      return await race(sandbox.page.screenshot({ type: "png", fullPage }), AbortSignal.any([pagesBudget, AbortSignal.timeout(pageTimeoutMs)]));
    } catch {
      if (ctx.signal.aborted) throw ctx.signal.reason;
      return null;
    }
  };

  /** Records a page: its full-page screenshot (read pages), then `page.surveyed` — its path, never the query. */
  const record = async (target: URL, result: PageRead, isStart: boolean): Promise<void> => {
    const shownUrl = result.ok ? result.url : target;
    const path = clip(surveyPath(shownUrl, start), 200);
    if (!result.ok) {
      pages.push({ url: surveyPageUrl(shownUrl), title: "", status: "SKIPPED" });
      await ctx.publish({ type: "page.surveyed", message: clip(`Skipped ${path} — ${result.reason}`, 300), payload: { path, title: "", status: "SKIPPED" } });
      return;
    }
    const inventory = toPageInventory(result.raw, ctx.redact);
    // The model is shown the start page as a viewport would show it; the stored evidence is the full page.
    if (isStart) screenshot = await shoot(false);
    const png = await shoot(true);
    if (png) {
      const { artifactId } = await store.saveScreenshot({ png, fileName: `${opts.fileNamePrefix}-${pages.length + 1}.png`, sensitivity });
      await ctx.publish({ type: "artifact.created", message: clip(`Full-page screenshot saved for ${path}`, 300), payload: { artifactId, type: "SCREENSHOT", sensitivity } });
    } else {
      await ctx.publish({
        type: "artifact.omitted",
        message: clip(`Screenshot of ${path} could not be taken`, 300),
        payload: { type: "SCREENSHOT", reason: "The browser could not take the screenshot" },
      });
    }
    pages.push({ url: surveyPageUrl(result.url), title: inventory.title, status: "READ" });
    const entry: SitePage = { url: surveyPageUrl(result.url), inventory };
    read.push(entry);
    if (interactive.budget.remaining > 0 && !interactive.budget.goalReached && !pagesBudget.aborted && typeof sandbox.page.locator === "function") {
      try {
        // One budget for the whole read (each action is bounded by ACTION_TIMEOUT_MS), so a flow can be followed
        // several actions deep on the page that leads to it (Sign in → the dialog's Sign up) instead of 20s a page.
        entry.interactions = [];
        const history = read.slice(0, -1).flatMap((p) => p.interactions ?? []);
        await explorePage(ctx, sandbox.page, { ...interactive, signal: pagesBudget, interactions: entry.interactions, history,
          screenshot: async () => {
            const png = await shoot(true);
            if (!png) return null;
            // Give the criteria/suggestion model the latest state discovered from the start page too.
            if (isStart) screenshot = await shoot(false) ?? screenshot;
            const { artifactId } = await store.saveScreenshot({ png, fileName: `${opts.fileNamePrefix}-${pages.length}-action-${interactive.visited.size}.png`, sensitivity });
            await ctx.publish({ type: "artifact.created", message: "Screenshot saved after exploring a live control", payload: { artifactId, type: "SCREENSHOT", sensitivity } });
            return artifactId;
          },
        });
      } catch {
        // Interaction is best effort; inventories and network already gathered are still useful.
        if (ctx.signal.aborted) throw ctx.signal.reason;
      }
    }
    const captured = network.slice(networkOffset);
    if (captured.length) entry.network = captured.slice(-50);
    networkOffset = network.length;
    await ctx.publish({
      type: "page.surveyed",
      message: clip(`Loaded ${path} — ${inventory.title || "(no title)"}`, 300),
      payload: { path, title: inventory.title, status: "READ" },
    });
  };

  try {
    const first = await load(start);
    await record(start, first, true);
    if (!first.ok) return { pages, read, screenshot, startFailure: first.reason };
    const links = chooseSurveyLinks({
      startUrl: start.href,
      links: first.raw.links,
      additionalAllowedHosts: additional,
      startAliases: [first.url.href],
      max: opts.maxLinks,
      ...(opts.rankLinks ? { rank: opts.rankLinks } : {}),
    });
    for (const link of links) {
      await ctx.boundary();
      if (pagesBudget.aborted) break;
      await record(link, await load(link), false);
    }
    return { pages, read, screenshot, startFailure: null };
  } finally {
    unsubscribe?.();
    sandbox.page.off?.("response", response);
    sandbox.page.off?.("requestfailed", failed);
  }
}
