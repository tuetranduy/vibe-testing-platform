import {
  CancelledError,
  ContractError,
  isInferred,
  liveSiteAnalysisOn,
  type RequirementIntent,
  type SiteAnalysisDraft,
  type SitePage,
  type StoredTestRunRequest,
  type SurveyedPage,
  type TestDataValue,
} from "@platform/contracts";
import type { LlmClient, LlmContentPart } from "@platform/llm";
import { requireLlm, type AnalyzedRequirement, type RequirementDraft, type StageContext } from "../orchestrator/stages";
import type { SurveyLink } from "../survey/links";
import { readSite, type SiteRead, type SurveySandbox, type SurveyStore } from "../survey/site-reader";
import { validateInsights, type RequirementInsights } from "./insights";
import { WHOLE_REQUIREMENT_NOTE, groundInferred, salvage, wholeRequirementFallback } from "./intent";
import { CompilerOutputSchema, type CompilerOutput } from "./model-output";
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
  site?: { pages: SitePage[]; screenshot: Buffer | null };
}

/** A compiled draft plus the advisory insights (V1.3): site checks and suggested test data. */
export type CompiledRequirement = RequirementDraft & { insights: RequirementInsights };

type Source = { originalText: string; testData: Record<string, TestDataValue>; secretNames: string[] };
type Settled = { ok: true; draft: RequirementDraft; output: CompilerOutput; notes: string[] } | { ok: false; issues: string[] };

const clip = (text: string, max: number): string => text.replace(/\s+/g, " ").trim().slice(0, max);

/** The model's own words about a criterion, to the contract: a rationale only on an inferred one, nothing too short to say anything. */
function tidy(output: CompilerOutput): CompilerOutput {
  const criteria = output.criteria.map((c) => {
    const { rationale, assumption, ...rest } = c;
    const why = isInferred(c) && rationale ? clip(rationale, 300) : "";
    const assumed = assumption ? clip(assumption, 300) : "";
    return { ...rest, ...(why.length >= 3 ? { rationale: why } : {}), ...(assumed.length >= 3 ? { assumption: assumed } : {}) };
  });
  return { ...output, criteria };
}

/**
 * The model's answer → a valid draft (2026-11-11, spec intent-understanding). Inferred criteria that are not grounded
 * are left out first, so they never cost the correction round. On the last answer (`final`) what is still invalid is
 * left out criterion by criterion, and when nothing is left the requirement is judged as a whole: an answer that
 * matches the output schema never fails the analysis.
 */
function settle(raw: CompilerOutput, source: Source, pagesRead: boolean, final: boolean): Settled {
  const grounded = groundInferred(tidy(raw), { pagesRead, secretNames: source.secretNames });
  const notes = [...grounded.notes];
  const whole = (output: CompilerOutput): Settled => {
    const fallback = { ...output, ...wholeRequirementFallback(source.originalText), siteChecks: [], testData: [] };
    const result = postValidate(fallback, source);
    return result.ok ? { ok: true, draft: result.draft, output: fallback, notes: [...notes, WHOLE_REQUIREMENT_NOTE] } : result;
  };
  let output = grounded.output;
  if (output.criteria.length === 0) return whole(output);
  // Leaving a criterion out can only remove issues, but each pass is checked again; the loop ends within the criteria count.
  for (;;) {
    const result = postValidate(output, source);
    if (result.ok) return { ok: true, draft: result.draft, output, notes };
    // Before the last answer only the analysis' own additions are left out: a fault in a criterion the user stated
    // is worth the correction round, one in a check nobody asked for is not.
    if (!final && !onlyInferred(output, result.issues)) return result;
    const kept = salvage(output, result.issues);
    if (!kept) return final ? whole(output) : result;
    notes.push(...kept.notes);
    output = kept.output;
  }
}

/** Every issue names a criterion (`criteria.<i>.…`) the analysis added. */
function onlyInferred(output: CompilerOutput, issues: readonly string[]): boolean {
  return issues.every((issue) => {
    const index = /^criteria\.(\d+)\b/.exec(issue)?.[1];
    const criterion = index === undefined ? undefined : output.criteria[Number(index)];
    return criterion !== undefined && isInferred(criterion);
  });
}

/** The intent as stored: the model's, clipped and masked; with notes and no intent from the model, a minimal one to carry them. */
function intentOf(output: CompilerOutput, notes: string[], originalText: string, redact: (v: unknown) => unknown): RequirementIntent | null {
  const said = output.intent;
  if (!said && notes.length === 0) return null;
  const mask = (text: string, max: number) => clip(String(redact(text)), max);
  const goal = mask(said?.goal || output.title || originalText, 300);
  const feature = said?.feature ? mask(said.feature, 80) : "";
  return {
    clarity: said?.clarity ?? "specific",
    goal: goal.length >= 3 ? goal : "The requirement holds",
    feature: feature === "" ? null : feature,
    notes: notes.slice(0, 10).map((n) => mask(n, 300)),
  };
}

/**
 * Natural-language requirement → structured criteria (the future revision 1). At most one correction
 * round covers both schema and post-validation failures; after that what is valid is kept (see `settle`), and
 * the compile fails with ContractError only when the answer does not match the output schema at all. The
 * orchestrator persists the draft and publishes the events. With `site`, the same call
 * sees the live site's pages and also returns site checks and test data values (validateInsights).
 */
export async function compileRequirement(llm: RequirementLlm, input: CompileRequirementInput): Promise<CompiledRequirement> {
  // A blank requirement is surveyed, never compiled: analysis only runs on a chosen text.
  if (input.originalText.trim() === "") throw new ContractError("The requirement is empty: there is nothing to compile");
  const source = { originalText: input.originalText, testData: input.testData, secretNames: input.secretNames };
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
    check: (output, context) => {
      const result = settle(output, source, pages.length > 0, context.corrected);
      return result.ok ? [] : result.issues;
    },
    stage: "ANALYZING_REQUIREMENT",
    runId: input.runId,
    signal: input.signal,
    deadlineAt: input.deadlineAt ?? null,
    redact: input.redact,
  });
  const result = settle(data, source, pages.length > 0, true);
  // Unreachable in practice (`check` already passed), but never hand an invalid draft on.
  if (!result.ok) throw new ContractError(`Compiled requirement is invalid: ${result.issues.join("; ")}`);
  const masked = (text: string | null | undefined) => (text ? { text: clip(String(input.redact(text)), 300) } : null);
  const draft: RequirementDraft = {
    ...result.draft,
    criteria: result.draft.criteria.map((c) => {
      const { rationale, assumption, ...rest } = c;
      const why = masked(rationale);
      const assumed = masked(assumption);
      return { ...rest, ...(why ? { rationale: why.text } : {}), ...(assumed ? { assumption: assumed.text } : {}) };
    }),
    intent: intentOf(result.output, result.notes, input.originalText, input.redact),
  };
  const insights = validateInsights({
    draft,
    output: result.output,
    testData: input.testData,
    secretNames: input.secretNames,
    siteRead: pages.length > 0,
    pages,
    seed: input.runId,
    redact: input.redact,
  });
  return { ...draft, ...(data.title ? { title: String(input.redact(data.title)).slice(0, 120) } : {}), insights };
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
 * Reads the live site for the analysis, best effort (the survey's reader), within its own
 * budget, including a bounded interactive pass. A failure never fails the analysis — it is recorded UNAVAILABLE with a short reason, and the
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
      siteAnalysis: {
        status: site.status,
        reason: site.reason,
        pages: site.pages,
        checks: insights.checks,
        testData: insights.testData,
        pageContents: site.read,
      },
    };
  };
}
