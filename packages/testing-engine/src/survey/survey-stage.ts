import { BrowserProviderError, CancelledError, EngineError, destructiveActionsAllowed, type SuggestionSetDraft } from "@platform/contracts";
import { requireLlm, type StageContext } from "../orchestrator/stages";
import { MAX_SURVEY_LINKS } from "./links";
import { readSite, type SurveySandbox, type SurveyStore } from "./site-reader";
import { suggestTests } from "./suggest";

export type { SurveySandbox, SurveyStore } from "./site-reader";

/** Each page — loading it and reading it — gets at most this long (spec: 20 s). */
export const SURVEY_PAGE_TIMEOUT_MS = 20_000;

export interface SurveyStageDeps {
  /** The run's sandbox: egress proxy, navigation guard, the run's allowed hosts — no Stagehand. */
  openSandbox(ctx: StageContext): Promise<SurveySandbox>;
  store(ctx: StageContext): SurveyStore;
  /** Receives a sandbox start-up failure's raw error (it may carry Chromium's stderr). */
  logger?: { error(obj: object, msg?: string): void };
  /** Test seam; SURVEY_PAGE_TIMEOUT_MS by default. */
  pageTimeoutMs?: number;
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

    let site;
    try {
      site = await readSite(ctx, { sandbox, store, pagesBudget, pageTimeoutMs, maxLinks: MAX_SURVEY_LINKS, fileNamePrefix: "survey" });
    } finally {
      await sandbox.close().catch(() => {});
    }
    if (site.startFailure !== null) throw new BrowserProviderError(`The start page could not be loaded (${site.startFailure})`);
    const { pages, read, screenshot } = site;
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
