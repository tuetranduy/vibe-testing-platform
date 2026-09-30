import {
  CancelledError,
  ContractError,
  liveSiteAnalysisOn,
  type SiteAnalysisDraft,
  type StoredTestRunRequest,
  type SurveyedPage,
  type TestDataValue,
} from "@platform/contracts";
import type { LlmClient, LlmContentPart } from "@platform/llm";
import { requireLlm, type AnalyzedRequirement, type RequirementDraft, type StageContext } from "../orchestrator/stages";
import type { PageInventory } from "../survey/inventory";
import type { SurveyLink } from "../survey/links";
import { readSite, type SiteRead, type SurveySandbox, type SurveyStore } from "../survey/site-reader";
import { validateInsights, type RequirementInsights } from "./insights";
import { CompilerOutputSchema } from "./model-output";
import { postValidate } from "./post-validate";
import { REQUIREMENT_SYSTEM_PROMPT, buildRequirementPrompt } from "./prompts";

/** The slice of LlmClient the compiler needs (lets tests and later stages substitute it). */
export type RequirementLlm = Pick<LlmClient, "generateStructured">;

export interface CompileRequirementInput {
  runId: string;
  originalText: string;
  /** Only the keys reach the prompt; values are used for the deterministic threshold check. */
  testData: Record<string, TestDataValue>;
  secretNames: string[];
  signal: AbortSignal;
  deadlineAt?: Date | null;
  /** The run redactor (masks secret values). */
  redact: (value: unknown) => unknown;
  /** Credentials taken from the requirement text (V1.3.1): names only. */
  inlineInputs?: StoredTestRunRequest["inlineInputs"];
  /** Pages of the live site read for this analysis (V1.3), and the start page's screenshot. */
  site?: { pages: { url: string; inventory: PageInventory }[]; screenshot: Buffer | null };
}

/** A compiled draft plus the advisory insights (V1.3): site checks and suggested test data. */
export type CompiledRequirement = RequirementDraft & { insights: RequirementInsights };

/**
 * Natural-language requirement → structured criteria (the future revision 1). At most one correction
 * round covers both schema and post-validation failures; after that the compile fails with
 * ContractError. The orchestrator persists the draft and publishes the events. With `site`, the same call
 * sees the live site's pages and also returns site checks and test data values (validateInsights).
 */
export async function compileRequirement(llm: RequirementLlm, input: CompileRequirementInput): Promise<CompiledRequirement> {
  // A blank requirement is surveyed, never compiled: analysis only runs on a chosen text.
  if (input.originalText.trim() === "") throw new ContractError("The requirement is empty: there is nothing to compile");
  const source = { originalText: input.originalText, testData: input.testData };
  const pages = input.site?.pages ?? [];
  const screenshot = pages.length > 0 ? (input.site?.screenshot ?? null) : null;
  const text = buildRequirementPrompt({
    originalText: input.originalText,
    testDataKeys: Object.keys(input.testData),
    secretNames: input.secretNames,
    inlineInputs: input.inlineInputs,
    pages: input.redact(pages) as typeof pages,
    hasScreenshot: screenshot !== null,
  });
  const content: string | LlmContentPart[] = screenshot
    ? [
        { type: "text", text },
        { type: "image", data: screenshot.toString("base64"), mimeType: "image/png" },
      ]
    : text;
  const { data } = await llm.generateStructured({
    schema: CompilerOutputSchema,
    schemaName: "requirement_criteria",
    system: REQUIREMENT_SYSTEM_PROMPT,
    messages: [{ role: "user", content }],
    check: (output) => {
      const result = postValidate(output, source);
      return result.ok ? [] : result.issues;
    },
    stage: "ANALYZING_REQUIREMENT",
    runId: input.runId,
    signal: input.signal,
    deadlineAt: input.deadlineAt ?? null,
    redact: input.redact,
  });
  const result = postValidate(data, source);
  // Unreachable in practice (`check` already passed), but never hand an invalid draft on.
  if (!result.ok) throw new ContractError(`Compiled requirement is invalid: ${result.issues.join("; ")}`);
  const insights = validateInsights({
    draft: result.draft,
    output: data,
    testData: input.testData,
    secretNames: input.secretNames,
    siteRead: pages.length > 0,
    seed: input.runId,
    redact: input.redact,
  });
  return { ...result.draft, insights };
}

/** The live-site read of the analysis (V1.3): the survey's sandbox (no Stagehand) and screenshot store. */
export interface AnalyzeSiteDeps {
  openSandbox(ctx: StageContext): Promise<SurveySandbox>;
  store(ctx: StageContext): SurveyStore;
  logger?: { error(obj: object, msg?: string): void; warn?(obj: object, msg?: string): void };
  /** Test seam; ANALYSIS_PAGE_TIMEOUT_MS by default. */
  pageTimeoutMs?: number;
}

export interface AnalyzeStageDeps {
  /** Absent: the live site is never read (the analysis works from the requirement alone). */
  site?: AnalyzeSiteDeps;
}

/** The analysis reads the start page and at most this many pages it links to. */
export const ANALYSIS_SITE_LINKS = 3;
/** Reading the live site stops after this long (or half the analysis' exploration budget, if less). */
export const ANALYSIS_SITE_BUDGET_MS = 45_000;
export const ANALYSIS_PAGE_TIMEOUT_MS = 15_000;

const STOP_WORDS = new Set([
  "that", "this", "with", "from", "have", "should", "must", "when", "then", "they", "their", "there", "into", "page", "user",
  "users", "able", "will", "each", "after", "before", "which", "what", "also", "only", "shows", "show", "click", "open",
]);

/** The requirement's content words (4+ letters), for ranking the links the analysis reads. */
export function requirementWords(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []).filter((w) => !STOP_WORDS.has(w)));
}

/** How many of the requirement's words a link's text and path share (the analysis reads the best first). */
export function linkRelevance(words: ReadonlySet<string>): (link: SurveyLink) => number {
  return (link) => {
    let path = "";
    try {
      path = decodeURIComponent(new URL(link.url).pathname);
    } catch {
      // not a URL: its text alone
    }
    const hay = new Set(`${link.text} ${path}`.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []);
    let score = 0;
    for (const w of words) if (hay.has(w) || [...hay].some((h) => h.startsWith(w) || w.startsWith(h))) score++;
    return score;
  };
}

interface LiveSite {
  status: SiteAnalysisDraft["status"];
  reason: string | null;
  pages: SurveyedPage[];
  read: SiteRead["read"];
  screenshot: Buffer | null;
}

const isAbort = (ctx: StageContext, err: unknown) => ctx.signal.aborted || err instanceof CancelledError;

/**
 * Reads the live site for the analysis, best effort: read-only (the survey's reader), within its own
 * budget. A failure never fails the analysis — it is recorded UNAVAILABLE with a short reason, and the
 * criteria are compiled from the requirement alone. Cancel and the hard deadline still end the run.
 */
async function readLiveSite(ctx: StageContext, deps: AnalyzeSiteDeps | undefined): Promise<LiveSite> {
  const none = (status: LiveSite["status"], reason: string, pages: SurveyedPage[] = []): LiveSite => ({ status, reason, pages, read: [], screenshot: null });
  if (!deps) return none("SKIPPED", "Reading the live site is not available for this run's engine");
  if (!liveSiteAnalysisOn(ctx.request)) return none("SKIPPED", "Turned off for this run");

  let sandbox: SurveySandbox;
  try {
    sandbox = await deps.openSandbox(ctx);
  } catch (err) {
    if (isAbort(ctx, err)) throw ctx.signal.reason ?? err;
    deps.logger?.error({ err, runId: ctx.runId }, "browser sandbox failed to start for the requirement analysis");
    return none("UNAVAILABLE", "The browser could not be started");
  }
  ctx.addCleanup(() => sandbox.close());
  try {
    const budgetMs = Math.min(ANALYSIS_SITE_BUDGET_MS, Math.floor(ctx.budgets.explorationMs / 2));
    const site = await readSite(ctx, {
      sandbox,
      store: deps.store(ctx),
      pagesBudget: ctx.budgetSignal(budgetMs),
      pageTimeoutMs: deps.pageTimeoutMs ?? ANALYSIS_PAGE_TIMEOUT_MS,
      maxLinks: ANALYSIS_SITE_LINKS,
      rankLinks: linkRelevance(requirementWords(ctx.request.requirement)),
      fileNamePrefix: "analysis",
    });
    if (site.startFailure !== null) return none("UNAVAILABLE", `The start page could not be read (${site.startFailure})`, site.pages);
    return { status: "READ", reason: null, pages: site.pages, read: site.read, screenshot: site.screenshot };
  } catch (err) {
    if (isAbort(ctx, err)) throw ctx.signal.reason ?? err;
    deps.logger?.warn?.({ err: err instanceof Error ? err.message : String(err), runId: ctx.runId }, "reading the live site failed; analyzing without it");
    return none("UNAVAILABLE", "Reading the live site failed");
  } finally {
    await sandbox.close().catch(() => {});
  }
}

/**
 * The real `analyze` stage: reads the live site (V1.3, see readLiveSite), then compiles the run's requirement
 * with the run's model client, redactor and deadline. Returns the draft with its site analysis: the pages
 * tried, the per-criterion site checks and the suggested test data.
 */
export function createAnalyzeStage(deps: AnalyzeStageDeps = {}): (ctx: StageContext) => Promise<AnalyzedRequirement> {
  return async (ctx) => {
    const llm = requireLlm(ctx); // before any browser: a run without a model client can't be analyzed
    if (ctx.request.requirement.trim() === "") throw new ContractError("The requirement is empty: there is nothing to compile");
    const site = await readLiveSite(ctx, deps.site);
    if (deps.site) await ctx.boundary(); // the site read took time: re-check cancel before the model call
    const { insights, ...draft } = await compileRequirement(llm, {
      runId: ctx.runId,
      originalText: ctx.request.requirement,
      testData: ctx.request.testData,
      secretNames: ctx.secrets.names,
      inlineInputs: ctx.request.inlineInputs,
      signal: ctx.signal,
      deadlineAt: ctx.deadlineAt,
      redact: ctx.redact,
      ...(site.read.length > 0 ? { site: { pages: site.read, screenshot: site.screenshot } } : {}),
    });
    return {
      ...draft,
      siteAnalysis: { status: site.status, reason: site.reason, pages: site.pages, checks: insights.checks, testData: insights.testData },
    };
  };
}
