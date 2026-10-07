import type { ArtifactSensitivity, SurveyedPage } from "@platform/contracts";
import type { Page } from "playwright-core";
import type { StageContext } from "../orchestrator/stages";
import { INVENTORY_SCRIPT, parseRawInventory, toPageInventory, type PageInventory, type RawPageInventory } from "./inventory";
import { chooseSurveyLinks, isAllowedPageHost, surveyPageUrl, surveyPath, type SurveyLink } from "./links";

/**
 * Reads a website the way the survey does (spec 2026-09-28-suggest-tests, section 5), for the survey and —
 * since V1.3 — for the requirement analysis: platform code loads the start page and a few same-site links by
 * URL (`page.goto`) and reads each with a fixed in-page script. Nothing is clicked, typed or submitted, and
 * the model never drives the browser. Each page read gets a full-page screenshot (stored and announced) and
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
  read: { url: string; inventory: PageInventory }[];
  /** The start page's viewport screenshot (PNG), for the model; null when there is none. */
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
      return await race(sandbox.page.screenshot({ type: "png", fullPage }), AbortSignal.any([ctx.signal, AbortSignal.timeout(pageTimeoutMs)]));
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
    read.push({ url: surveyPageUrl(result.url), inventory });
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
  }
}
