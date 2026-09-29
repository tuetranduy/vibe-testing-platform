import {
  BrowserProviderError,
  CancelledError,
  EngineError,
  destructiveActionsAllowed,
  type ArtifactSensitivity,
  type SuggestionSetDraft,
  type SurveyedPage,
} from "@platform/contracts";
import type { Page } from "playwright-core";
import { requireLlm, type StageContext } from "../orchestrator/stages";
import { INVENTORY_SCRIPT, parseRawInventory, toPageInventory, type PageInventory, type RawPageInventory } from "./inventory";
import { chooseSurveyLinks, isAllowedPageHost, surveyPageUrl, surveyPath } from "./links";
import { suggestTests } from "./suggest";

/** Each page — loading it and reading it — gets at most this long (spec: 20 s). */
export const SURVEY_PAGE_TIMEOUT_MS = 20_000;

/** A run's browser for the survey: the worker's RunSandbox, opened without the Stagehand extension. */
export interface SurveySandbox {
  page: Page;
  /** Blocked main-frame navigations (the worker's navigation guard). */
  onNavigationBlocked?(listener: (e: { url: string; reason: string }) => void): () => void;
  close(): Promise<void>;
}

export interface SurveyStore {
  saveScreenshot(input: { png: Buffer; fileName: string; sensitivity: ArtifactSensitivity }): Promise<{ artifactId: string }>;
}

export interface SurveyStageDeps {
  /** The run's sandbox: egress proxy, navigation guard, the run's allowed hosts — no Stagehand. */
  openSandbox(ctx: StageContext): Promise<SurveySandbox>;
  store(ctx: StageContext): SurveyStore;
  /** Receives a sandbox start-up failure's raw error (it may carry Chromium's stderr). */
  logger?: { error(obj: object, msg?: string): void };
  /** Test seam; SURVEY_PAGE_TIMEOUT_MS by default. */
  pageTimeoutMs?: number;
}

type PageRead = { ok: true; url: URL; raw: RawPageInventory } | { ok: false; reason: string };

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Settles with `work`, or rejects when `signal` fires first (the work is abandoned; closing the sandbox ends it). */
function race<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
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

/**
 * The real `survey` stage (spec section 5): read-only by construction. Platform code loads the start
 * page and up to 5 same-site links by URL (`page.goto`) and reads each with a fixed in-page script —
 * nothing is clicked, typed or submitted, and the model never drives the browser. Page loading stops
 * once 60 % of the survey's time is used; then one model call proposes the tests. The browser is
 * closed before that call, and is always released (finally + the stage cleanup).
 */
export function createSurveyStage(deps: SurveyStageDeps): (ctx: StageContext) => Promise<SuggestionSetDraft> {
  const pageTimeoutMs = deps.pageTimeoutMs ?? SURVEY_PAGE_TIMEOUT_MS;
  return async (ctx) => {
    const llm = requireLlm(ctx); // before any browser: a run without a model client can't survey
    const start = new URL(ctx.request.targetUrl);
    const additional = ctx.request.options.additionalAllowedHosts;
    // The run's usual rule (the executor's): a run with secrets marks its screenshots SECRET_BEARING.
    const sensitivity: ArtifactSensitivity = ctx.secrets.names.length > 0 || ctx.request.secretNames.length > 0 ? "SECRET_BEARING" : "STANDARD";
    // createRunContext makes budgets.explorationMs 60 % of the job's total — SURVEY_TIMEOUT_SECONDS for
    // the survey job — so page loading stops there and the rest is left for the model call.
    const pagesBudget = ctx.budgetSignal(ctx.budgets.explorationMs);
    const store = deps.store(ctx);

    const sandbox = await deps.openSandbox(ctx).catch((err: unknown) => {
      if (ctx.signal.aborted) throw ctx.signal.reason;
      if (err instanceof EngineError || err instanceof CancelledError) throw err;
      deps.logger?.error({ err, runId: ctx.runId }, "browser sandbox failed to start");
      throw new BrowserProviderError("Browser sandbox failed to start", { cause: err });
    });
    ctx.addCleanup(() => sandbox.close());

    let blocked = false;
    const unsubscribe = sandbox.onNavigationBlocked?.(() => {
      blocked = true;
    });
    const pages: SurveyedPage[] = [];
    const read: { url: string; inventory: PageInventory }[] = [];
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
        const raw = parseRawInventory(await race(sandbox.page.evaluate(INVENTORY_SCRIPT), limit));
        return { ok: true, url: landed, raw };
      } catch (err) {
        if (ctx.signal.aborted) throw ctx.signal.reason;
        if (pagesBudget.aborted) return { ok: false, reason: "time budget used up" };
        if (blocked || /ERR_BLOCKED_BY_CLIENT/.test(messageOf(err))) return { ok: false, reason: "blocked by policy" };
        return { ok: false, reason: "did not load" };
      }
    };

    /** Records a page: its screenshot (read pages), then `page.surveyed` — its path, never the query. */
    const record = async (target: URL, result: PageRead, isStart: boolean): Promise<void> => {
      const shownUrl = result.ok ? result.url : target;
      const path = clip(surveyPath(shownUrl, start), 200);
      if (!result.ok) {
        pages.push({ url: surveyPageUrl(shownUrl), title: "", status: "SKIPPED" });
        await ctx.publish({ type: "page.surveyed", message: clip(`Skipped ${path} — ${result.reason}`, 300), payload: { path, title: "", status: "SKIPPED" } });
        return;
      }
      const inventory = toPageInventory(result.raw, ctx.redact);
      let png: Buffer | null = null;
      try {
        png = await race(sandbox.page.screenshot({ type: "png" }), AbortSignal.any([ctx.signal, AbortSignal.timeout(pageTimeoutMs)]));
      } catch {
        if (ctx.signal.aborted) throw ctx.signal.reason;
      }
      if (png) {
        const { artifactId } = await store.saveScreenshot({ png, fileName: `survey-${pages.length + 1}.png`, sensitivity });
        await ctx.publish({ type: "artifact.created", message: clip(`Screenshot saved for ${path}`, 300), payload: { artifactId, type: "SCREENSHOT", sensitivity } });
        if (isStart) screenshot = png;
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
      if (!first.ok) throw new BrowserProviderError(`The start page could not be loaded (${first.reason})`);
      const links = chooseSurveyLinks({ startUrl: start.href, links: first.raw.links, additionalAllowedHosts: additional, startAliases: [first.url.href] });
      for (const link of links) {
        await ctx.boundary();
        if (pagesBudget.aborted) break;
        await record(link, await load(link), false);
      }
    } finally {
      unsubscribe?.();
      await sandbox.close().catch(() => {});
    }
    await ctx.boundary();

    const suggestions = await suggestTests(llm, {
      runId: ctx.runId,
      startUrl: ctx.request.targetUrl,
      environment: ctx.request.environment,
      destructiveAllowed: destructiveActionsAllowed(ctx.request),
      testDataKeys: Object.keys(ctx.request.testData),
      secretNames: ctx.secrets.names,
      pages: read,
      screenshot,
      signal: ctx.signal,
      deadlineAt: ctx.deadlineAt,
      redact: ctx.redact,
    });
    return { suggestions, pages };
  };
}
