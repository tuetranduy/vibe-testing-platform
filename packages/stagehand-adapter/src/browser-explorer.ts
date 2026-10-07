import { BrowserProviderError } from "@platform/contracts";
import type { LlmClient } from "@platform/llm";
import type { Page } from "playwright-core";
import type { ZodType } from "zod";

/**
 * Provider-neutral exploration interfaces (Task 14). Only this package knows Stagehand; the
 * executor (testing-engine) programs against these types.
 */

export type NavigationBlockReason = "OFF_DOMAIN_NAVIGATION" | "TARGET_BLOCKED_BY_POLICY";

export interface NavigationBlock {
  url: string;
  reason: NavigationBlockReason;
}

/**
 * The sandboxed browser the explorer drives (Ruling R10). Structural, so the worker's
 * `SandboxedBrowser` / `RunSandbox` satisfy it without this package importing from apps.
 */
export interface SandboxedPage {
  /** `http://127.0.0.1:<cdpPort>` */
  cdpUrl: string;
  /** Extensions loaded into the browser; the Stagehand runtime must be one of them. */
  extensionIds: string[];
  /** The Playwright page (via `connectOverCDP`) the explorer works on. */
  page: Page;
  /** Blocked main-frame navigations (the worker's navigation guard). Optional. */
  onNavigationBlocked?(listener: (e: NavigationBlock) => void): () => void;
  /**
   * Sets the page back to its emulated viewport after a full-page screenshot, which can drop it (the page then shrank
   * to the window's size for the rest of the run, and of its video). Optional.
   */
  restoreViewport?(): Promise<void>;
}

/** Per-step model usage (`ExplorationStep.llm`). `cacheHit` is null in V1 (Ruling R21). */
export interface LlmStepUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheHit: boolean | null;
}

/**
 * An element the explorer found or acted on. `selector` is an absolute XPath in Playwright form
 * (`xpath=/html[1]/body[1]/button[1]`): feed it to the recorder (`recordElement`) for replayable
 * locators, to `fillElement` for our own deterministic fills, or back to `actOn`.
 */
export interface ObservedElement {
  selector: string;
  description: string;
  /** Suggested method (click, fill, …), if any. */
  method: string | null;
  /** Suggested arguments. Model-chosen: never trust them for values (fill with our own data instead). */
  arguments: string[];
}

export interface ActResult {
  success: boolean;
  message: string;
  /** The element acted on (first executed action), when available. */
  element: ObservedElement | null;
  /** Main-frame navigations blocked by the navigation guard while acting. */
  navigationBlocks: NavigationBlock[];
  llm: LlmStepUsage | null;
}

export interface ObserveResult {
  elements: ObservedElement[];
  llm: LlmStepUsage | null;
}

export interface ExtractResult<T> {
  /** Model-extracted: MODEL_EXTRACTED until the fact reader confirms it from the DOM. */
  data: T;
  llm: LlmStepUsage | null;
}

export interface NavigateResult {
  /** The page URL after the navigation. */
  url: string;
}

/** A navigation the navigation guard stopped. The session stays usable. */
export class NavigationBlockedError extends Error {
  override readonly name = "NavigationBlockedError";
  constructor(
    readonly url: string,
    /** Null when the guard's event did not arrive (the browser still reported ERR_BLOCKED_BY_CLIENT). */
    readonly reason: NavigationBlockReason | null,
  ) {
    super(`Navigation blocked by policy (${reason ?? "BLOCKED"})`);
  }
}

/** The session was closed, or the run signal fired. */
export class ExplorerSessionClosedError extends Error {
  override readonly name = "ExplorerSessionClosedError";
}

/**
 * The explorer briefly lost the page (its CDP session or the page's script context, right after a page change,
 * KI-051): the same call may work once the page settles. Still a browser provider failure for everything else.
 */
export class ExplorerTransientError extends BrowserProviderError {}

/**
 * One exploration session on one page. Operations are serialized; each result carries the model
 * usage it caused. Nothing here fills secret values: use the recorder's `fillElement`.
 */
export interface ExplorerSession {
  /** The Playwright page being explored (same target Stagehand drives). */
  readonly page: Page;
  /** Deterministic navigation (no model). Throws `NavigationBlockedError` when the guard blocks it. */
  navigate(url: string): Promise<NavigateResult>;
  /** Finds candidate elements for an instruction without acting. */
  observe(instruction: string): Promise<ObserveResult>;
  /** Lets the model pick and perform one action. `success: false` when it could not. */
  act(instruction: string): Promise<ActResult>;
  /** Replays an observed element's action deterministically (zero model calls). */
  actOn(element: ObservedElement): Promise<ActResult>;
  /** Model extraction validated against `schema`. */
  extract<T>(instruction: string, schema: ZodType<T>): Promise<ExtractResult<T>>;
  /** PNG of the viewport, or of the whole scrollable page with `fullPage: true` (V1.3). */
  screenshot(options?: { fullPage?: boolean }): Promise<Buffer>;
  /** Detaches the explorer. Never closes the browser (the sandbox owns it). Idempotent. */
  close(): Promise<void>;
}

export interface ExplorerStartInput {
  page: SandboxedPage;
  runId: string;
  /**
   * The run's model client: Stagehand's calls go through it (redaction, retries, LlmCall records), at the
   * run's reasoning level (see client-llm.ts).
   */
  llm: Pick<LlmClient, "model" | "generateJson">;
  signal: AbortSignal;
  /** The run redactor (by key and value) applied to every model request and forwarded log. Required: no fail-open default. */
  redact: (value: unknown) => unknown;
  /**
   * The run's action policy (`allowDestructive`). Picks the guardrail text Stagehand is given; enforcement
   * stays with the executor. Required, like `redact`: no fail-open default.
   */
  allowDestructive: boolean;
  /** Model retries never back off past this instant. */
  deadlineAt?: Date | null;
}

export interface BrowserExplorer {
  start(input: ExplorerStartInput): Promise<ExplorerSession>;
}
